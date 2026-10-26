// Leave By platform layer.
// The app was first built as a Claude artifact, which talks to `window.claude`.
// This file provides the same small interface, backed by our own services:
//   - accounts + saved schedules: Supabase (Sign in with Google)
//   - live traffic + address lookup: TomTom, through our /api/tomtom server function
// Features that still depend on Claude-only connectors are switched off below.

window.FEATURES = { shifts: false, transit: false };

(function () {
  let sb = null;
  let session = null;

  // Start up Supabase once, using public settings served by /api/config.
  const ready = (async () => {
    try {
      const res = await fetch("/api/config");
      const cfg = res.ok ? await res.json() : null;
      if (cfg && cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase) {
        sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
        const { data } = await sb.auth.getSession();
        session = data.session;
      }
    } catch (e) {
      console.warn("Leave By: account service unavailable", e);
    }
    renderAuthBox();
  })();

  // ---------- Sign in / sign out buttons in the Account card ----------
  function renderAuthBox() {
    const box = document.getElementById("authBox");
    if (!box) return;
    box.innerHTML = "";
    if (!sb) {
      box.innerHTML = '<p class="note">Accounts aren\'t set up yet, so your schedule saves on this device.</p>';
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    if (session) {
      btn.className = "btn ghost";
      btn.textContent = "Sign out";
      btn.onclick = async () => {
        btn.disabled = true;
        await sb.auth.signOut();
        try { localStorage.removeItem("leaveby.v1"); } catch (e) {}
        location.reload();
      };
    } else {
      btn.className = "btn grad google-btn";
      btn.innerHTML = '<span class="g" aria-hidden="true">G</span> Sign in with Google';
      btn.onclick = async () => {
        btn.disabled = true;
        const { error } = await sb.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: location.origin + location.pathname },
        });
        if (error) { btn.disabled = false; alertNote("Couldn't start Google sign-in. Try again."); }
      };
    }
    box.appendChild(btn);
  }
  function alertNote(t) { const n = document.getElementById("acctNote"); if (n) n.textContent = t; }

  // ---------- Helpers ----------
  function initialsAvatar(name) {
    const letter = ((name || "?").trim()[0] || "?").toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b2bd6"/><stop offset=".5" stop-color="#c13584"/><stop offset="1" stop-color="#f77737"/></linearGradient></defs><circle cx="32" cy="32" r="32" fill="url(#g)"/><text x="32" y="42" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">${letter.replace(/[<&>"]/g, "")}</text></svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }
  function viewer() {
    const u = session && session.user;
    const meta = (u && u.user_metadata) || {};
    const name = String(meta.full_name || meta.name || "").trim();
    return {
      id: u ? u.id : null,
      name,
      avatarUrl: meta.avatar_url || meta.picture || initialsAvatar(name || (u && u.email)),
      color: "#8134af",
      email: (u && u.email) || null,
      isOwner: false,
      canEdit: false,
    };
  }
  const fail = (code, message) => Promise.reject({ code, message: message || code });

  // ---------- Capabilities ----------
  const userApi = {
    me: async () => { await ready; return viewer(); },
    id: async () => { await ready; return viewer().id; },
    name: async () => { await ready; return viewer().name; },
    profiles: async (ids) => {
      await ready;
      const v = viewer(), out = {};
      (Array.isArray(ids) ? ids : [ids]).forEach((id) => { out[id] = id === v.id ? { id, name: v.name } : { id, name: "" }; });
      return out;
    },
  };

  const dbApi = {
    doc() {
      // The app only ever stores one document per person: their planner.
      return {
        async get() {
          await ready;
          if (!sb || !session) return fail("not_signed_in");
          const { data, error } = await sb.from("planners").select("state, saved_at").eq("user_id", session.user.id).maybeSingle();
          if (error) return fail("upstream_error", error.message);
          return { exists: !!data, data: () => (data ? { state: data.state, savedAt: data.saved_at } : undefined) };
        },
        async set(obj) {
          await ready;
          if (!sb || !session) return fail("not_signed_in");
          const { error } = await sb.from("planners").upsert({
            user_id: session.user.id,
            state: String(obj.state || ""),
            saved_at: Number(obj.savedAt) || Date.now(),
          });
          if (error) return fail("upstream_error", error.message);
        },
      };
    },
  };

  // Small in-memory cache so repeat traffic checks don't use up the TomTom quota.
  const ttCache = new Map();
  const mcpApi = {
    async callTool(server, tool, input) {
      if (server !== "TomTom Maps" || (tool !== "tomtom-geocode" && tool !== "tomtom-routing")) {
        return fail("server_not_connected");
      }
      const key = tool + JSON.stringify(input || {});
      const hit = ttCache.get(key);
      if (hit && Date.now() - hit.at < 10 * 60 * 1000) return { payload: hit.payload };
      let res;
      try {
        res = await fetch("/api/tomtom", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool, input }),
        });
      } catch (e) {
        return fail("upstream_error", "network");
      }
      if (!res.ok) return fail("upstream_error", "status " + res.status);
      const payload = await res.json();
      ttCache.set(key, { at: Date.now(), payload });
      return { payload };
    },
  };

  window.claude = {
    async use(name) {
      if (name === "user") { await ready; return sb ? userApi : null; }
      if (name === "db") { await ready; return sb && session ? dbApi : null; }
      if (name === "mcp") return mcpApi;
      return null; // "sample" (screenshot import) isn't set up in this version
    },
  };
})();
