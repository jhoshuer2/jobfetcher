// Background runs. Daily (Vercel Cron, ~7am Lagos): refresh the job pool, score, draft and email a summary.
// Light (?light=1, every few hours from GitHub Actions): refresh the pool and score only, so fresh roles show up within hours.
// People are processed oldest-first until the time budget runs out; anyone not reached is caught up when they open the site.
const { db, gmailSend, baseUrl } = require('./_lib');
const { refreshPool, processUser } = require('./_jobs');

module.exports = async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  const deadline = Date.now() + 52000;
  const light = String((req.query || {}).light || '') === '1';
  const report = { pool: null, users: [], light };
  try {
    report.pool = await refreshPool({ force: true });
    const uids = await db.redis('SMEMBERS', 'users') || [];
    const last = await Promise.all(uids.map(u => db.get('lastrun:' + u)));
    const order = uids.map((u, i) => [u, +last[i] || 0]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
    for (const uid of order) {
      if (Date.now() > deadline - 15000) break;
      const r = await processUser(uid, deadline, { draft: !light });
      report.users.push({ uid, scored: r.scored, drafted: r.drafted.length });
      if (!light && r.drafted.length) await digest(uid, r.drafted, baseUrl(req)).catch(() => {});
    }
    return res.status(200).json(report);
  } catch (e) {
    return res.status(500).json({ error: e.message, report });
  }
};

// A short "applications ready for review" email to the person's own inbox, sent from their own Gmail.
async function digest(uid, drafted, site) {
  const [user, settings] = await Promise.all([db.get('user:' + uid), db.get('settings:' + uid)]);
  if (!user || !user.gmailOk || !user.refreshEnc || (settings && settings.digest === false)) return;
  const lines = drafted.map(a => `• ${a.job.title} at ${a.job.company}${a.method === 'email' ? ' (Radar can send this one)' : ' (apply via their form)'}`);
  await gmailSend(user, {
    to: user.email,
    subject: `Radar: ${drafted.length} application${drafted.length > 1 ? 's' : ''} ready for review`,
    text: `Hi ${user.name ? user.name.split(' ')[0] : 'there'},\n\nRadar found strong matches and drafted applications for you:\n\n${lines.join('\n')}\n\nNothing has been sent. Review and approve them here:\n${site}/#review\n\nRadar`
  });
}
