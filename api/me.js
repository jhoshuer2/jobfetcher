// The signed-in person's own data: profile, interview, CV, settings.
const { requireUser, readJson, db, balance } = require('./_lib');

const DEFAULT_SETTINGS = { threshold: 75, digest: true, autoDraft: 2 };

module.exports = async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  const uid = user.uid;

  if (req.method === 'GET') {
    const [profile, radar, settings, cvMeta, pv, bal] = await Promise.all([
      db.get('profile:' + uid), db.get('radar:' + uid), db.get('settings:' + uid), db.get('cvmeta:' + uid), db.get('pv:' + uid), balance(user)
    ]);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      user: { email: user.email, name: user.name, picture: user.picture, gmailOk: !!(user.gmailOk && user.refreshEnc) },
      profile, radar, pv: pv || 0, cv: cvMeta, balance: bal, settings: { ...DEFAULT_SETTINGS, ...(settings || {}) }
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  let body; try { body = await readJson(req); } catch { return res.status(400).json({ error: 'Bad JSON' }); }
  switch (body.action) {
    case 'radar': {
      const r = body.radar || {};
      const clean = { name: String(r.name || '').slice(0, 60), brief: String(r.brief || '').slice(0, 5000), done: !!r.done, wrap: !!r.wrap, voice: r.voice !== false,
        messages: (Array.isArray(r.messages) ? r.messages : []).slice(-60).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) })) };
      await db.set('radar:' + uid, clean);
      return res.status(200).json({ ok: true });
    }
    case 'profile': {
      if (!body.profile || typeof body.profile !== 'object') return res.status(400).json({ error: 'No profile' });
      const p = JSON.parse(JSON.stringify(body.profile).slice(0, 12000));
      const pv = await db.redis('INCR', 'pv:' + uid);
      await db.set('profile:' + uid, p);
      await db.redis('SET', 'pv:' + uid, pv);
      return res.status(200).json({ ok: true, pv });
    }
    case 'settings': {
      const s = body.settings || {};
      const settings = { threshold: Math.max(50, Math.min(95, +s.threshold || 75)), digest: s.digest !== false, autoDraft: Math.max(0, Math.min(5, Math.round(+(s.autoDraft ?? 2)))) };
      await db.set('settings:' + uid, settings);
      return res.status(200).json({ ok: true, settings });
    }
    case 'cv': {
      const b64 = String(body.b64 || '');
      if (!b64 || b64.length > 4_200_000) return res.status(400).json({ error: 'CV missing or over 3 MB' });
      const mime = /^application\/pdf$|^text\//.test(body.mime || '') ? body.mime : 'application/pdf';
      const name = String(body.name || 'CV.pdf').replace(/[^\w .()-]/g, '').slice(0, 80) || 'CV.pdf';
      await db.set('cv:' + uid, { name, mime, b64 });
      await db.set('cvmeta:' + uid, { name, mime, size: Math.round(b64.length * 0.75), at: Date.now() });
      return res.status(200).json({ ok: true });
    }
    case 'delete': {
      const keys = ['profile', 'radar', 'settings', 'cv', 'cvmeta', 'pv', 'matches', 'apps', 'user'].map(k => k + ':' + uid);
      await db.del(...keys);
      await db.redis('SREM', 'users', uid);
      res.setHeader('Set-Cookie', 'jr_s=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
      return res.status(200).json({ ok: true });
    }
  }
  return res.status(400).json({ error: 'Unknown action' });
};
