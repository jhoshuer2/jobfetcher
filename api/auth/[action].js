// Google sign-in.
//   /api/auth/login    → basic sign-in (name + email only; no Google review needed)
//   /api/auth/gmail    → optional extra step: "Send email on your behalf" (gmail.send), for one-tap sending
//   /api/auth/callback → back from Google;  /api/auth/logout → clears the session
const crypto = require('crypto');
const { requireEnv, baseUrl, db, encrypt, setCookie, parseCookies, makeSession, readSession, allowed } = require('../_lib');

const BASIC = ['openid', 'email', 'profile'];
const GMAIL = 'https://www.googleapis.com/auth/gmail.send';
const redirect = (res, to) => { res.statusCode = 302; res.setHeader('Location', to); res.end(); };

module.exports = async (req, res) => {
  const action = req.query.action;
  if (action === 'logout') { setCookie(res, 'jr_s', '', 0); return redirect(res, '/'); }
  if (!requireEnv(res, 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET')) return;
  const callback = baseUrl(req) + '/api/auth/callback';

  if (action === 'login' || action === 'gmail') {
    const flow = action;
    const state = flow + '.' + crypto.randomBytes(16).toString('hex');
    setCookie(res, 'jr_state', state, 600);
    const q = { client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: callback, response_type: 'code', state, include_granted_scopes: 'true', access_type: 'offline' };
    if (flow === 'gmail') {
      const uid = readSession(req);
      const user = uid && await db.get('user:' + uid);
      if (!user) return redirect(res, '/');
      Object.assign(q, { scope: [...BASIC, GMAIL].join(' '), prompt: 'consent', login_hint: user.email });
    } else {
      Object.assign(q, { scope: BASIC.join(' '), prompt: 'select_account' });
    }
    return redirect(res, 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(q));
  }

  if (action === 'callback') {
    const { code, state, error } = req.query;
    const saved = parseCookies(req).jr_state || '';
    const flow = String(state || '').split('.')[0];
    if (error) return redirect(res, flow === 'gmail' ? '/#settings' : '/#signin-cancelled');
    if (!code || !state || state !== saved) return redirect(res, '/#signin-failed');
    setCookie(res, 'jr_state', '', 0);
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: callback, grant_type: 'authorization_code' })
    });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.id_token) return redirect(res, '/#signin-failed');
    // The id_token comes straight from Google's token endpoint over TLS, so its payload can be read directly.
    const claims = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString('utf8'));
    if (!claims.sub || !claims.email || claims.email_verified === false) return redirect(res, '/#signin-failed');
    if (!allowed(claims.email)) return redirect(res, '/#not-invited');

    const uid = 'g' + claims.sub;
    const prev = (await db.get('user:' + uid)) || {};
    const granted = String(t.scope || '').includes('gmail.send');
    const user = { ...prev, uid, email: claims.email, name: claims.name || prev.name || '', picture: claims.picture || prev.picture || '', createdAt: prev.createdAt || Date.now(), lastLogin: Date.now() };
    // A new refresh token replaces the old one; Gmail sending is on only if this token covers gmail.send.
    if (t.refresh_token) { user.refreshEnc = encrypt(t.refresh_token); user.gmailOk = granted; }
    else if (granted && prev.refreshEnc) user.gmailOk = true;
    await db.set('user:' + uid, user);
    await db.redis('SADD', 'users', uid);
    setCookie(res, 'jr_s', makeSession(uid), 30 * 86400);
    return redirect(res, flow === 'gmail' ? (granted ? '/#settings-gmail-on' : '/#settings') : '/#radar');
  }

  res.status(404).json({ error: 'Unknown auth action' });
};
