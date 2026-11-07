// GET → this person's strong matches + applications.  POST {action:'sync'} → refresh the pool if stale, score + draft, return the feed.
const { requireUser, requireEnv, readJson } = require('./_lib');
const { refreshPool, processUser, feed } = require('./_jobs');

module.exports = async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'POST') {
      if (!requireEnv(res, 'ANTHROPIC_API_KEY')) return;
      const body = await readJson(req).catch(() => ({}));
      if (body.action === 'sync') {
        const deadline = Date.now() + 50000;
        const meta = await refreshPool({ force: !!body.force });
        const r = await processUser(user.uid, deadline, { draft: body.draft !== false });
        return res.status(200).json({ ...(await feed(user.uid)), ran: { scored: r.scored, drafted: r.drafted.length, poolAt: meta.at } });
      }
      return res.status(400).json({ error: 'Unknown action' });
    }
    return res.status(200).json(await feed(user.uid));
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
