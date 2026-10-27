// Server function: keeps people connected to Google Calendar without reconnecting every hour.
// - "store": after someone connects, saves Google's refresh token for their account.
// - "access": trades the saved refresh token for a fresh one-hour access token.
// - "disconnect": deletes the saved token and tells Google to revoke it.
// Refresh tokens live only in the calendar_tokens table, which browsers can't read
// (row-level security with no policies); only this function, using the service key, can.
// Needs Vercel env vars: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
// GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (the same OAuth client used for Google sign-in).

async function signedInUser(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY;
  if (!token || !url || !anon) return null;
  const r = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

function db(path, init = {}) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ code: "bad_request" });
  }
  const { SUPABASE_SERVICE_ROLE_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  if (!SUPABASE_SERVICE_ROLE_KEY || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ code: "not_configured" });
  }
  const user = await signedInUser(req).catch(() => null);
  if (!user) return res.status(401).json({ code: "not_signed_in" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const action = body && body.action;
  const uid = encodeURIComponent(user.id);

  try {
    if (action === "store") {
      const rt = String((body && body.refreshToken) || "");
      if (!rt || rt.length > 2048) return res.status(400).json({ code: "bad_request" });
      const r = await db("calendar_tokens", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ user_id: user.id, refresh_token: rt, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) return res.status(502).json({ code: "upstream_error" });
      return res.status(200).json({ ok: true });
    }

    if (action === "access") {
      const r = await db(`calendar_tokens?select=refresh_token&user_id=eq.${uid}`);
      if (!r.ok) return res.status(502).json({ code: "upstream_error" });
      const rows = await r.json();
      const rt = rows && rows[0] && rows[0].refresh_token;
      if (!rt) return res.status(200).json({ code: "needs_reauth" });
      const g = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: rt, grant_type: "refresh_token" }),
      });
      const gj = await g.json().catch(() => ({}));
      if (!g.ok || !gj.access_token) {
        if (gj.error === "invalid_grant") { // revoked or expired: forget it so the app asks to reconnect
          await db(`calendar_tokens?user_id=eq.${uid}`, { method: "DELETE" });
          return res.status(200).json({ code: "needs_reauth" });
        }
        return res.status(502).json({ code: "upstream_error" });
      }
      return res.status(200).json({ accessToken: gj.access_token, expiresIn: gj.expires_in || 3600 });
    }

    if (action === "disconnect") {
      const r = await db(`calendar_tokens?select=refresh_token&user_id=eq.${uid}`);
      const rows = r.ok ? await r.json() : [];
      const rt = rows && rows[0] && rows[0].refresh_token;
      if (rt) {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: rt }),
        }).catch(() => {});
      }
      await db(`calendar_tokens?user_id=eq.${uid}`, { method: "DELETE" });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ code: "bad_request" });
  } catch (e) {
    return res.status(502).json({ code: "upstream_error" });
  }
}
