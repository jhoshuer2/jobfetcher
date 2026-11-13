// Applications: prepare a draft, edit it, send it from Gmail (after you approve), or mark it applied/skipped.
const { requireUser, requireEnv, readJson, db, quotaOr429, gmailSend, spendDraft, refundDraft, balance } = require('./_lib');
const { loadUser, draftFor, candidates } = require('./_jobs');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await requireUser(req, res); if (!user) return;
  let body; try { body = await readJson(req); } catch { return res.status(400).json({ error: 'Bad JSON' }); }
  const key = String(body.key || '');
  if (!key) return res.status(400).json({ error: 'No job' });
  const appsKey = 'apps:' + user.uid;

  try {
    if (body.action === 'draft') {
      if (!requireEnv(res, 'ANTHROPIC_API_KEY')) return;
      const u = await loadUser(user.uid);
      if (!u.profile) return res.status(400).json({ error: 'Finish your Radar interview first' });
      const pool = await db.hscanAll('pool');
      const job = candidates(pool, u).find(j => j.key === key) || (pool[key] && { ...pool[key], key });
      if (!job) return res.status(404).json({ error: 'That job is no longer on the board' });
      if (await db.hget(appsKey, key)) return res.status(409).json({ error: 'Already prepared, see Review' });
      if (!(await quotaOr429(res, user.uid, 'draft'))) return;
      const source = await spendDraft(user);
      if (!source) return res.status(402).json({ error: 'You\'ve used your free applications. Get a pack to keep going.', code: 'no_credits', balance: await balance(user) });
      let app;
      try { app = await draftFor(user.uid, u, job, user.email); }
      catch (e) { await refundDraft(user, source); throw e; }
      app.paidWith = source;
      await db.hset(appsKey, { [key]: app });
      return res.status(200).json({ app, balance: await balance(user) });
    }

    let app = await db.hget(appsKey, key);
    if (!app && body.action === 'mark') {
      // "Not for me" / "I applied" on a job with no draft yet
      const j = await db.hget('pool', key);
      if (!j) return res.status(404).json({ error: 'That job is no longer on the board' });
      app = { key, status: 'review', method: 'form', job: { title: j.title, company: j.company, url: j.url, location: j.location }, createdAt: Date.now() };
    }
    if (!app) return res.status(404).json({ error: 'No application for that job yet' });

    if (body.action === 'update') {
      const f = body.fields || {};
      for (const k of ['to', 'subject', 'body', 'coverLetter']) if (typeof f[k] === 'string') app[k] = f[k].slice(0, k === 'coverLetter' ? 5000 : 4000);
      if (Array.isArray(f.answers)) app.answers = f.answers.slice(0, 6).map(a => ({ q: String(a.q || '').slice(0, 200), a: String(a.a || '').slice(0, 1200) }));
      await db.hset(appsKey, { [key]: app });
      return res.status(200).json({ app });
    }

    if (body.action === 'send') {
      if (app.method !== 'email') return res.status(400).json({ error: 'This job needs its application form, Radar can\'t send it' });
      if (app.status === 'sent') return res.status(409).json({ error: 'Already sent' });
      if (!user.gmailOk || !user.refreshEnc) return res.status(400).json({ error: 'Gmail isn\'t connected. Sign out and back in, and allow "Send email on your behalf".', code: 'no_gmail' });
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(app.to || '')) return res.status(400).json({ error: 'Add a valid recipient email' });
      if (!(await quotaOr429(res, user.uid, 'send'))) return;
      const cv = body.attachCv === false ? null : await db.get('cv:' + user.uid);
      const id = await gmailSend(user, { to: app.to, subject: app.subject, text: app.body, attachment: cv && cv.mime === 'application/pdf' ? { name: cv.name, mime: cv.mime, b64: cv.b64 } : null });
      Object.assign(app, { status: 'sent', sentAt: Date.now(), gmailId: id, attachedCv: !!(cv && cv.mime === 'application/pdf') });
      await db.hset(appsKey, { [key]: app });
      return res.status(200).json({ app });
    }

    if (body.action === 'mark') {
      const status = ['applied', 'skipped', 'review'].includes(body.status) ? body.status : null;
      if (!status) return res.status(400).json({ error: 'Bad status' });
      if (app.status === 'sent' && status !== 'applied') return res.status(409).json({ error: 'Already sent' });
      app.status = status; if (status === 'applied') app.sentAt = Date.now();
      await db.hset(appsKey, { [key]: app });
      return res.status(200).json({ app });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(502).json({ error: e.message, code: e.code });
  }
};
