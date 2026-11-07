// Google sign-in. /api/auth/login → Google → /api/auth/callback → back to the app. /api/auth/logout clears the session.
const crypto = require('crypto');
const { requireEnv, baseUrl, db, encrypt, setCookie, parseCookies, makeSession, allowed } = require('../_lib');

const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.send'];
const redirect = (res, to) => { res.statusCode = 302; res.setHeader('Location', to); res.end(); };

module.exports = async (req, res) => {
  const action = req.query.action;
  if (action === 'logout') { setCookie(res, 'jr_s', '', 0); return redirect(res, '/'); }
  if (!requireEnv(res, 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET')) return;
  const callback = baseUrl(req) + '/api/auth/callback';

  if (action === 'login') {
    const state = crypto.randomBytes(16).toString('hex');
    setCookie(res, 'jr_state', state, 600);
    const q = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: callback, response_type: 'code',
      scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state
    });
    return redirect(res, 'https://accounts.google.com/o/oauth2/v2/auth?' + q);
  }

  if (action === 'callback') {
    const { code, state, error } = req.query;
    if (error) return redirect(res, '/#signin-cancelled');
    if (!code || !state || state !== parseCookies(req).jr_state) return redirect(res, '/#signin-failed');
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
    const gmailOk = String(t.scope || '').includes('gmail.send');
    const user = {
      ...prev, uid, email: claims.email, name: claims.name || prev.name || '', picture: claims.picture || '',
      gmailOk, refreshEnc: t.refresh_token ? encrypt(t.refresh_token) : prev.refreshEnc, createdAt: prev.createdAt || Date.now(), lastLogin: Date.now()
    };
    if (!gmailOk) user.refreshEnc = prev.refreshEnc && prev.gmailOk ? prev.refreshEnc : user.refreshEnc;
    await db.set('user:' + uid, user);
    await db.redis('SADD', 'users', uid);
    setCookie(res, 'jr_s', makeSession(uid), 30 * 86400);
    return redirect(res, '/#radar');
  }

  res.status(404).json({ error: 'Unknown auth action' });
};
