// Leave By platform layer.
// The app was first built as a Claude artifact, which talks to `window.claude`.
// This file provides the same small interface, backed by our own services:
//   - accounts + saved schedules: Supabase (Sign in with Google)
//   - live traffic + address lookup: TomTom, through our /api/tomtom server function
// Features that still depend on Claude-only connectors are switched off below.

window.FEATURES = { shifts: true, transit: false };

(function () {
  let sb = null;
  let session = null;
  let importEnabled = false;
  let transitEnabled = false;

  // Start up Supabase once, using public settings served by /api/config.
  const ready = (async () => {
    try {
      const res = await fetch("/api/config");
      const cfg = res.ok ? await res.json() : null;
      importEnabled = !!(cfg && cfg.importEnabled);
      transitEnabled = !!(cfg && cfg.transitEnabled);
      if (cfg && cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase) {
        sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
        const { data } = await sb.auth.getSession();
        session = data.session;
        // Coming back from "Connect Google Calendar": keep the calendar access token for this hour.
        try {
          if (localStorage.getItem("lb.gcalPending") && session && session.provider_token) {
            localStorage.setItem("lb.gcal", JSON.stringify({ token: session.provider_token, at: Date.now() }));
            localStorage.setItem("lb.gcalJustConnected", "1");
          }
          localStorage.removeItem("lb.gcalPending");
        } catch (e) {}
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
        try { ["leaveby.v1", "lb.gcal", "lb.gcalPending", "lb.gcalJustConnected"].forEach((k) => localStorage.removeItem(k)); } catch (e) {}
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

  // ---------- Google Calendar (read-only, straight from the browser with the user's own token) ----------
  const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
  function calendarToken() {
    try {
      const g = JSON.parse(localStorage.getItem("lb.gcal") || "null");
      if (g && g.token && Date.now() - g.at < 55 * 60 * 1000) return g.token;
    } catch (e) {}
    return null;
  }
  async function connectCalendar() {
    await ready;
    if (!sb) return fail("not_configured");
    try { localStorage.setItem("lb.gcalPending", "1"); } catch (e) {}
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: location.origin + location.pathname,
        scopes: GCAL_SCOPE,
        queryParams: { include_granted_scopes: "true" },
      },
    });
    if (error) return fail("upstream_error", error.message);
  }
  async function gcalGet(path, params) {
    const token = calendarToken();
    if (!token) return fail("needs_reauth");
    const url = "https://www.googleapis.com/calendar/v3/" + path + (params ? "?" + new URLSearchParams(params) : "");
    let r;
    try { r = await fetch(url, { headers: { Authorization: "Bearer " + token } }); }
    catch (e) { return fail("upstream_error", "network"); }
    if (r.status === 401 || r.status === 403) { try { localStorage.removeItem("lb.gcal"); } catch (e) {} return fail("needs_reauth"); }
    if (!r.ok) return fail("upstream_error", "status " + r.status);
    return r.json();
  }
  async function googleCalendar(tool, input) {
    if (tool === "list_calendars") {
      const j = await gcalGet("users/me/calendarList", { maxResults: "250" });
      const calendars = (j.items || []).map((c) => ({ id: c.id, summary: c.summaryOverride || c.summary || "", description: c.description || "", primary: !!c.primary }));
      return { payload: { calendars } };
    }
    if (tool === "list_events") {
      const toIso = (s) => { const d = new Date(s); return isNaN(d) ? undefined : d.toISOString(); };
      const params = { singleEvents: "true", orderBy: "startTime", maxResults: String(Math.min(250, +input.pageSize || 250)) };
      if (input.startTime) params.timeMin = toIso(input.startTime);
      if (input.endTime) params.timeMax = toIso(input.endTime);
      const j = await gcalGet("calendars/" + encodeURIComponent(input.calendarId || "primary") + "/events", params);
      const events = (j.items || []).map((e) => ({ summary: e.summary || "", status: e.status, start: e.start || {}, end: e.end || {}, location: e.location || "", description: e.description || "" }));
      return { payload: { events } };
    }
    return fail("server_not_connected");
  }

  // Small in-memory cache so repeat traffic checks don't use up the TomTom quota.
  const ttCache = new Map();
  const mcpApi = {
    async callTool(server, tool, input) {
      if (server === "Google Calendar") return googleCalendar(tool, input || {});
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

  // ---------- Screenshot import (Claude reads the image on our server) ----------
  // Shrink the photo in the browser first so uploads are fast and small.
  async function shrinkImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
      const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL("image/jpeg", 0.88);
      return { mediaType: "image/jpeg", image: dataUrl.split(",")[1] };
    } finally { URL.revokeObjectURL(url); }
  }
  function parseJsonLoose(text) {
    try { return JSON.parse(text); } catch (e) {}
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    if (fence) { try { return JSON.parse(fence[1]); } catch (e) {} }
    const a = text.search(/[\[{]/), b = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
    if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) {} }
    throw { code: "invalid_json", message: "Couldn't read the answer", text };
  }
  async function askAboutImage(file) {
    await ready;
    if (!sb || !session) return fail("not_signed_in");
    const f = Array.isArray(file) ? file[0] : (file && file.length !== undefined && !(file instanceof Blob) ? file[0] : file);
    if (!(f instanceof Blob)) return fail("image_rejected");
    let payload;
    try { payload = await shrinkImage(f); } catch (e) { return fail("image_rejected"); }
    const { data } = await sb.auth.getSession();
    const token = data && data.session && data.session.access_token;
    let res;
    try {
      res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + (token || "") },
        body: JSON.stringify(payload),
      });
    } catch (e) { return fail("upstream_error", "network"); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return fail(j.code || "upstream_error", j.error);
    return j.text || "";
  }
  const sampleApi = async () => fail("not_supported");
  sampleApi.json = async (_prompt, opts) => parseJsonLoose(await askAboutImage(opts && opts.images));
  sampleApi.limits = async () => ({
    maxPromptBytes: 262144,
    images: { maxCount: 1, maxInputBytes: 20_000_000, mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] },
  });

  // ---------- Transit options (Google Routes on our server) ----------
  window.LB = {
    ready,
    signedIn: async () => { await ready; return !!(sb && session); },
    calendarConnected: () => !!calendarToken(),
    connectCalendar,
    takeJustConnected: () => { try { const v = localStorage.getItem("lb.gcalJustConnected"); localStorage.removeItem("lb.gcalJustConnected"); return !!v; } catch (e) { return false; } },
    transitEnabled: async () => { await ready; return transitEnabled; },
    async transit(from, to, arriveAt) {
      await ready;
      if (!sb || !session) return fail("not_signed_in");
      const { data } = await sb.auth.getSession();
      const token = data && data.session && data.session.access_token;
      let res;
      try {
        res = await fetch("/api/transit", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + (token || "") },
          body: JSON.stringify({ from, to, arriveAt }),
        });
      } catch (e) { return fail("upstream_error", "network"); }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return fail(j.code || "upstream_error", j.error);
      return Array.isArray(j.routes) ? j.routes : [];
    },
  };

  window.claude = {
    async use(name) {
      if (name === "user") { await ready; return sb ? userApi : null; }
      if (name === "db") { await ready; return sb && session ? dbApi : null; }
      if (name === "mcp") return mcpApi;
      if (name === "sample") { await ready; return importEnabled && sb && session ? sampleApi : null; }
      return null;
    },
  };
})();
