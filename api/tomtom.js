// Server function: looks up addresses and live drive times with TomTom.
// The TomTom key lives only on the server (Vercel env var TOMTOM_KEY), never in the page.
// It answers in the same shape the app already understands.

const BASE = "https://api.tomtom.com";

const isLonLat = (p) =>
  Array.isArray(p) && p.length === 2 &&
  Number.isFinite(+p[0]) && Number.isFinite(+p[1]) &&
  Math.abs(+p[0]) <= 180 && Math.abs(+p[1]) <= 90;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }
  const key = process.env.TOMTOM_KEY;
  if (!key) return res.status(500).json({ error: "TOMTOM_KEY is not set on the server" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { tool, input } = body || {};

  try {
    if (tool === "tomtom-geocode") {
      const q = String((input && input.query) || "").trim().slice(0, 200);
      if (!q) return res.status(400).json({ error: "Missing address" });
      const params = new URLSearchParams({ key, limit: "1", countrySet: "US" });
      if (input && isLonLat(input.position)) {
        params.set("lon", String(+input.position[0]));
        params.set("lat", String(+input.position[1]));
      }
      const r = await fetch(`${BASE}/search/2/geocode/${encodeURIComponent(q)}.json?${params}`);
      if (!r.ok) return res.status(502).json({ error: "TomTom geocode failed", status: r.status });
      const j = await r.json();
      const hit = j.results && j.results[0];
      return res.status(200).json({
        features: hit && hit.position ? [{
          geometry: { coordinates: [hit.position.lon, hit.position.lat] },
          properties: { address: { freeformAddress: (hit.address && hit.address.freeformAddress) || q } },
        }] : [],
      });
    }

    if (tool === "tomtom-routing") {
      const locs = input && input.locations;
      if (!Array.isArray(locs) || locs.length !== 2 || !locs.every(isLonLat)) {
        return res.status(400).json({ error: "Need exactly two [lon, lat] points" });
      }
      const pts = locs.map((p) => `${+p[1]},${+p[0]}`).join(":");
      const params = new URLSearchParams({ key, traffic: "true", travelMode: "car", routeType: "fastest" });
      // Plan for the arrival or departure time when it's in the future; otherwise use right now.
      const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
      const arrive = input.arriveAt ? Date.parse(input.arriveAt) : NaN;
      const depart = input.departAt ? Date.parse(input.departAt) : NaN;
      if (Number.isFinite(arrive) && arrive > Date.now() + 60_000) params.set("arriveAt", iso(arrive));
      else if (Number.isFinite(depart) && depart > Date.now() + 60_000) params.set("departAt", iso(depart));
      const r = await fetch(`${BASE}/routing/1/calculateRoute/${pts}/json?${params}`);
      if (!r.ok) return res.status(502).json({ error: "TomTom routing failed", status: r.status });
      const j = await r.json();
      const sm = j.routes && j.routes[0] && j.routes[0].summary;
      return res.status(200).json({
        features: sm ? [{
          properties: {
            summary: {
              travelTimeInSeconds: sm.travelTimeInSeconds,
              trafficDelayInSeconds: sm.trafficDelayInSeconds || 0,
              lengthInMeters: sm.lengthInMeters,
            },
          },
        }] : [],
      });
    }

    return res.status(400).json({ error: "Unknown request" });
  } catch (e) {
    return res.status(502).json({ error: "Couldn't reach TomTom" });
  }
}
