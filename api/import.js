// Server function: reads a schedule screenshot with Claude and returns the classes/shifts it finds.
// - Only signed-in Leave By users can use it (checked against Supabase).
// - The prompt is fixed here on the server, so this can't be used as a general-purpose Claude proxy.
// - The Claude API key lives only on the server (Vercel env var ANTHROPIC_API_KEY).

const MODEL = "claude-haiku-5-5";
const MAX_IMAGE_BYTES = 3_500_000; // after base64 decoding; the page shrinks images well below this
const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const PROMPT =
  "This image is a screenshot of a student's weekly class schedule or a work shift schedule. " +
  "Extract every recurring class, lab, section, or shift. Reply with only a JSON array, one object per item, shaped like " +
  '{"label":"ISE 315 Lecture","days":[1,3,5],"start":"09:30","end":"10:20","location":"MGH 241"}. ' +
  "days uses 0=Sunday through 6=Saturday. start and end are 24-hour HH:MM. " +
  "location is the room or building if shown, else an empty string. " +
  "If nothing in the image is a schedule, reply with [].";

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ code: "bad_request", error: "Use POST" });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ code: "not_configured", error: "Screenshot import isn't set up yet" });

  const user = await signedInUser(req).catch(() => null);
  if (!user) return res.status(401).json({ code: "not_signed_in", error: "Sign in to import a screenshot" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const mediaType = String((body && body.mediaType) || "");
  const data = String((body && body.image) || "");
  if (!MEDIA_TYPES.has(mediaType) || !/^[A-Za-z0-9+/=]+$/.test(data)) {
    return res.status(400).json({ code: "image_rejected", error: "Send a PNG, JPG, WebP, or GIF image" });
  }
  if (Math.floor((data.length * 3) / 4) > MAX_IMAGE_BYTES) {
    return res.status(413).json({ code: "image_rejected", error: "That image is too large" });
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data } },
            { type: "text", text: PROMPT },
          ],
        }],
      }),
    });
    if (r.status === 429) return res.status(429).json({ code: "rate_limited", error: "Too many requests" });
    if (!r.ok) return res.status(502).json({ code: "upstream_error", error: "Claude request failed", status: r.status });
    const j = await r.json();
    const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!text) return res.status(502).json({ code: "empty_completion", error: "No answer" });
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ code: "upstream_error", error: "Couldn't reach Claude" });
  }
}
