// Server function: finds bus / train / light rail options with Google's Routes API.
// - Signed-in Leave By users only, so strangers can't use up the free monthly allowance.
// - The Google key lives only on the server (Vercel env var GOOGLE_MAPS_KEY).
// Answers with a short, simple list the app can show next to the drive time.

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const FIELDS = [
  "routes.duration",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.transitDetails",
].join(",");

const isLonLat = (p) =>
  Array.isArray(p) && p.length === 2 &&
  Number.isFinite(+p[0]) && Number.isFinite(+p[1]) &&
  Math.abs(+p[0]) <= 180 && Math.abs(+p[1]) <= 90;
const secs = (d) => (typeof d === "string" ? parseFloat(d) || 0 : 0); // "123s" -> 123

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

function summarize(route) {
  const steps = (route.legs || []).flatMap((l) => l.steps || []);
  const firstT = steps.findIndex((s) => s.travelMode === "TRANSIT");
  if (firstT < 0) return null; // walking-only answers aren't useful here
  let lastT = -1;
  steps.forEach((s, i) => { if (s.travelMode === "TRANSIT") lastT = i; });

  const walkBefore = steps.slice(0, firstT).reduce((t, s) => t + secs(s.staticDuration), 0);
  const walkAfter = steps.slice(lastT + 1).reduce((t, s) => t + secs(s.staticDuration), 0);
  const walkTotal = steps.filter((s) => s.travelMode === "WALK").reduce((t, s) => t + secs(s.staticDuration), 0);

  const lines = steps.filter((s) => s.travelMode === "TRANSIT" && s.transitDetails).map((s) => {
    const td = s.transitDetails, line = td.transitLine || {}, stops = td.stopDetails || {};
    return {
      type: (line.vehicle && line.vehicle.type) || "TRANSIT",
      short: line.nameShort || "",
      name: line.name || "",
      agency: (line.agencies && line.agencies[0] && line.agencies[0].name) || "",
      from: (stops.departureStop && stops.departureStop.name) || "",
      to: (stops.arrivalStop && stops.arrivalStop.name) || "",
      departs: stops.departureTime || null,
    };
  });

  const t1 = steps[firstT].transitDetails && steps[firstT].transitDetails.stopDetails;
  const tN = steps[lastT].transitDetails && steps[lastT].transitDetails.stopDetails;
  const dep = t1 && t1.departureTime ? Date.parse(t1.departureTime) : NaN;
  const arr = tN && tN.arrivalTime ? Date.parse(tN.arrivalTime) : NaN;
  const leaveAt = Number.isFinite(dep) ? new Date(dep - walkBefore * 1000).toISOString() : null;
  const arriveAt = Number.isFinite(arr) ? new Date(arr + walkAfter * 1000).toISOString() : null;
  const minutes = leaveAt && arriveAt
    ? Math.round((Date.parse(arriveAt) - Date.parse(leaveAt)) / 60000)
    : Math.round(secs(route.duration) / 60);

  return { minutes, leaveAt, arriveAt, walkMinutes: Math.round(walkTotal / 60), lines };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ code: "bad_request", error: "Use POST" });
  }
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key) return res.status(503).json({ code: "not_configured", error: "Transit isn't set up yet" });

  const user = await signedInUser(req).catch(() => null);
  if (!user) return res.status(401).json({ code: "not_signed_in", error: "Sign in to compare transit" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { from, to, arriveAt } = body || {};
  if (!isLonLat(from) || !isLonLat(to)) return res.status(400).json({ code: "bad_request", error: "Need two places with addresses" });

  const request = {
    origin: { location: { latLng: { latitude: +from[1], longitude: +from[0] } } },
    destination: { location: { latLng: { latitude: +to[1], longitude: +to[0] } } },
    travelMode: "TRANSIT",
    computeAlternativeRoutes: true,
    languageCode: "en-US",
    units: "IMPERIAL",
  };
  const t = arriveAt ? Date.parse(arriveAt) : NaN;
  if (Number.isFinite(t) && t > Date.now() + 60_000) request.arrivalTime = new Date(t).toISOString();

  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELDS },
      body: JSON.stringify(request),
    });
    if (r.status === 429) return res.status(429).json({ code: "rate_limited", error: "Daily transit limit reached" });
    if (!r.ok) return res.status(502).json({ code: "upstream_error", error: "Google Routes request failed", status: r.status });
    const j = await r.json();
    const routes = (j.routes || []).map(summarize).filter(Boolean).slice(0, 3);
    return res.status(200).json({ routes });
  } catch (e) {
    return res.status(502).json({ code: "upstream_error", error: "Couldn't reach Google" });
  }
}
