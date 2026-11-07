// Fetches public job feeds server-side so the browser can't block them.
// Only these hosts are allowed. Responses are cached at Vercel's edge for 6 hours
// (which also keeps us inside Remotive's "a few requests a day" limit).
const ALLOWED = new Set([
  'remotive.com', 'jobicy.com', 'remoteok.com', 'himalayas.app',
  'weworkremotely.com', 'workingnomads.com', 'hn.algolia.com',
  'api.ashbyhq.com', 'boards-api.greenhouse.io', 'api.lever.co'
]);

module.exports = async (req, res) => {
  let target;
  try {
    target = new URL(String(req.query.url || ''));
  } catch {
    return res.status(400).json({ error: 'Missing or invalid url' });
  }
  if (target.protocol !== 'https:' || !ALLOWED.has(target.hostname.replace(/^www\./, ''))) {
    return res.status(403).json({ error: 'Host not allowed' });
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: { 'User-Agent': 'JobRadar/2.0 (personal job board)', Accept: 'application/json, application/rss+xml, text/xml;q=0.9, */*;q=0.5' },
      signal: AbortSignal.timeout(15000)
    });
    if (!upstream.ok) return res.status(502).json({ error: 'Upstream HTTP ' + upstream.status });
    const body = await upstream.text();
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', /json/.test(type) ? 'application/json; charset=utf-8' : /xml|rss/.test(type) ? 'application/xml; charset=utf-8' : type);
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');
    return res.status(200).send(body);
  } catch (e) {
    return res.status(502).json({ error: 'Upstream failed: ' + (e && e.message) });
  }
};
