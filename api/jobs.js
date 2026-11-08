// GET → this person's strong matches + applications.  POST {action:'sync'} → refresh the pool if stale, score + draft, return the feed.
const { requireUser, requireEnv, readJson, buyScoreBoost, BOOST_SCORES, balance } = require('./_lib');
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
        const t0 = Date.now();
        const meta = await refreshPool({ force: !!body.force });
        // If this pass had to fetch fresh listings, return them straight away so the person sees roles being scored;
        // the client calls again to score.
        if (Date.now() - t0 > 4000) return res.status(200).json({ ...(await feed(user.uid)), ran: { scored: 0, drafted: 0, poolAt: meta.at, refreshed: true } });
        const r = await processUser(user.uid, deadline, { draft: body.draft !== false });
        return res.status(200).json({ ...(await feed(user.uid)), ran: { scored: r.scored, drafted: r.drafted.length, poolAt: meta.at, error: r.error } });
      }
      if (body.action === 'boost') {   // 1 credit → score BOOST_SCORES more roles today
        if (!(await buyScoreBoost(user.uid))) return res.status(402).json({ error: 'You need a credit to score more today.', code: 'no_credits', balance: await balance(user) });
        return res.status(200).json({ ok: true, added: BOOST_SCORES(), balance: await balance(user) });
      }
      return res.status(400).json({ error: 'Unknown action' });
    }
    return res.status(200).json(await feed(user.uid));
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
