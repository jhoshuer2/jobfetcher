// Shared server helpers. Files starting with "_" are not exposed as endpoints by Vercel.
const crypto = require('crypto');

/* ---------------- request / response ---------------- */
async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}
function missingEnv(...names) {
  return names.filter(n => !process.env[n]);
}
function requireEnv(res, ...names) {
  const miss = missingEnv(...names);
  if (miss.length) { res.status(501).json({ error: 'not_configured', missing: miss.join(', ') }); return false; }
  return true;
}
function baseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
const today = () => new Date().toISOString().slice(0, 10);

/* ---------------- Upstash Redis (REST) ---------------- */
const R_URL = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const R_TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function redis(...cmd) {
  const r = await fetch(R_URL(), { method: 'POST', headers: { Authorization: `Bearer ${R_TOKEN()}`, 'content-type': 'application/json' }, body: JSON.stringify(cmd.map(String)) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error('Database error: ' + (d.error || r.status));
  return d.result;
}
async function pipe(cmds) {
  if (!cmds.length) return [];
  const r = await fetch(R_URL().replace(/\/+$/, '') + '/pipeline', { method: 'POST', headers: { Authorization: `Bearer ${R_TOKEN()}`, 'content-type': 'application/json' }, body: JSON.stringify(cmds.map(c => c.map(String))) });
  const d = await r.json().catch(() => []);
  if (!r.ok || !Array.isArray(d)) throw new Error('Database error: ' + r.status);
  return d.map(x => x.result);
}
const db = {
  async get(k) { const v = await redis('GET', k); return v == null ? null : JSON.parse(v); },
  async set(k, v) { return redis('SET', k, JSON.stringify(v)); },
  async del(...k) { return k.length ? redis('DEL', ...k) : 0; },
  async hgetall(k) {
    const arr = await redis('HGETALL', k) || [];
    const o = {};
    for (let i = 0; i < arr.length; i += 2) { try { o[arr[i]] = JSON.parse(arr[i + 1]); } catch { } }
    return o;
  },
  async hget(k, f) { const v = await redis('HGET', k, f); return v == null ? null : JSON.parse(v); },
  async hset(k, obj) {
    const flat = Object.entries(obj).flatMap(([f, v]) => [f, JSON.stringify(v)]);
    return flat.length ? redis('HSET', k, ...flat) : 0;
  },
  async hdel(k, ...f) { return f.length ? redis('HDEL', k, ...f) : 0; },
  redis, pipe
};

/* ---------------- crypto: sessions + encrypted tokens ---------------- */
const KEY = () => crypto.createHash('sha256').update(String(process.env.SESSION_SECRET || '')).digest();
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function sign(data) { return crypto.createHmac('sha256', KEY()).update(data).digest('base64url'); }
function encrypt(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', KEY(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function setCookie(res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (process.env.NODE_ENV !== 'development') parts.push('Secure');
  const prev = res.getHeader ? res.getHeader('Set-Cookie') : null;
  res.setHeader('Set-Cookie', [].concat(prev || [], parts.join('; ')));
}
function makeSession(uid) {
  const exp = Date.now() + 30 * 864e5;
  const data = `${uid}.${exp}`;
  return `${data}.${sign(data)}`;
}
function readSession(req) {
  const raw = parseCookies(req).jr_s;
  if (!raw) return null;
  const i = raw.lastIndexOf('.');
  const data = raw.slice(0, i), sig = raw.slice(i + 1);
  const good = sign(data);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const [uid, exp] = data.split('.');
  if (!uid || +exp < Date.now()) return null;
  return uid;
}
// Loads the signed-in user, or replies 401 and returns null.
async function requireUser(req, res) {
  if (!requireEnv(res, 'SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET')) return null;
  if (!R_URL() || !R_TOKEN()) { res.status(501).json({ error: 'not_configured', missing: 'KV_REST_API_URL, KV_REST_API_TOKEN (Upstash)' }); return null; }
  const uid = readSession(req);
  const user = uid ? await db.get('user:' + uid) : null;
  if (!user) { res.status(401).json({ error: 'signed_out' }); return null; }
  if (!allowed(user.email)) { res.status(403).json({ error: 'not_invited' }); return null; }
  return user;
}
function allowed(email) {
  const list = String(process.env.ALLOWED_EMAILS || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  return !list.length || list.includes(String(email || '').toLowerCase());
}

/* ---------------- per-user daily limits (protects the owner's credits) ---------------- */
const LIMITS = { chat: 120, tts: 120, stt: 120, score: 200, draft: 25, send: 15 };
async function useQuota(uid, kind, n = 1) {
  const max = Math.round(LIMITS[kind] * (+process.env.LIMIT_MULTIPLIER || 1));
  const key = `use:${uid}:${kind}:${today()}`;
  const [count] = await pipe([['INCRBY', key, n], ['EXPIRE', key, 172800]]);
  return count <= max;
}
async function quotaOr429(res, uid, kind, n = 1) {
  if (await useQuota(uid, kind, n)) return true;
  res.status(429).json({ error: `Daily limit reached for ${kind}. It resets tomorrow.` });
  return false;
}

/* ---------------- Claude ---------------- */
async function claude({ model, system, messages, maxTokens = 1024 }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, system, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(55000)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((data.error && data.error.message) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
function extractJson(text) {
  const t = String(text || '').replace(/```(?:json)?/g, '');
  const starts = [t.indexOf('{'), t.indexOf('[')].filter(i => i >= 0);
  if (!starts.length) return null;
  const s = Math.min(...starts), close = t[s] === '{' ? '}' : ']', e = t.lastIndexOf(close);
  if (e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}
const MODELS = {
  chat: () => process.env.CHAT_MODEL || 'claude-sonnet-5-5',
  match: () => process.env.MATCH_MODEL || 'claude-haiku-5-5',
  draft: () => process.env.DRAFT_MODEL || process.env.CHAT_MODEL || 'claude-sonnet-5-5'
};

/* ---------------- Google tokens + Gmail ---------------- */
async function googleAccessToken(user) {
  if (!user.refreshEnc) throw Object.assign(new Error('Gmail not connected'), { code: 'no_gmail' });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: decrypt(user.refreshEnc) })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw Object.assign(new Error('Google sign-in expired. Sign out and back in.'), { code: 'no_gmail' });
  return d.access_token;
}
const mimeWord = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
function buildMime({ from, to, subject, text, attachment }) {
  const boundary = 'jr_' + crypto.randomBytes(8).toString('hex');
  const head = [`From: ${from}`, `To: ${to}`, `Subject: ${mimeWord(subject)}`, 'MIME-Version: 1.0'];
  if (!attachment) return [...head, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(text).toString('base64')].join('\r\n');
  return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(text).toString('base64'),
    `--${boundary}`, `Content-Type: ${attachment.mime}; name="${attachment.name.replace(/"/g, '')}"`, `Content-Disposition: attachment; filename="${attachment.name.replace(/"/g, '')}"`, 'Content-Transfer-Encoding: base64', '',
    attachment.b64.replace(/(.{76})/g, '$1\r\n'), `--${boundary}--`, ''].join('\r\n');
}
async function gmailSend(user, msg) {
  const token = await googleAccessToken(user);
  const raw = b64u(buildMime({ from: user.name ? `${mimeWord(user.name)} <${user.email}>` : user.email, ...msg }));
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ raw })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Gmail refused the message: ' + ((d.error && d.error.message) || r.status));
  return d.id;
}

/* ---------------- credits: 2 free drafted applications, then paid packs ---------------- */
const FREE_DRAFTS = () => Math.max(0, +(process.env.FREE_APPLICATIONS ?? 2));
const isOwner = email => String(process.env.OWNER_EMAILS || '').toLowerCase().split(/[\s,]+/).filter(Boolean).includes(String(email || '').toLowerCase());
// Packs: PACKS env as JSON, e.g. [{"id":"p5","apps":5,"amount":3000,"label":"Starter"}]; amount is in the main currency unit (naira).
function packs() {
  try { const p = JSON.parse(process.env.PACKS || ''); if (Array.isArray(p) && p.length) return p; } catch { }
  return [
    { id: 'p5', apps: 5, amount: 3000, label: 'Starter' },
    { id: 'p15', apps: 15, amount: 7500, label: 'Job hunt' },
    { id: 'p40', apps: 40, amount: 15000, label: 'All in' }
  ];
}
const CURRENCY = () => (process.env.PAY_CURRENCY || 'NGN').toUpperCase();
async function balance(user) {
  const [used, credits] = await pipe([['GET', 'drafts_used:' + user.uid], ['GET', 'credits:' + user.uid]]);
  const freeLeft = Math.max(0, FREE_DRAFTS() - (+used || 0));
  return { owner: isOwner(user.email), freeLeft, credits: Math.max(0, +credits || 0), free: FREE_DRAFTS() };
}
// Takes one application from the free allowance first, then from paid credits. Returns the source, or null if none left.
async function spendDraft(user) {
  if (isOwner(user.email)) return 'owner';
  const used = await redis('INCR', 'drafts_used:' + user.uid);
  if (used <= FREE_DRAFTS()) return 'free';
  await redis('DECR', 'drafts_used:' + user.uid);
  const left = await redis('DECRBY', 'credits:' + user.uid, 1);
  if (left >= 0) return 'credit';
  await redis('INCRBY', 'credits:' + user.uid, 1);
  return null;
}
async function refundDraft(user, source) {
  if (source === 'free') await redis('DECR', 'drafts_used:' + user.uid);
  if (source === 'credit') await redis('INCRBY', 'credits:' + user.uid, 1);
}

module.exports = {
  FREE_DRAFTS, isOwner, packs, CURRENCY, balance, spendDraft, refundDraft,
  readJson, requireEnv, missingEnv, baseUrl, today, db, redis, pipe,
  encrypt, decrypt, setCookie, parseCookies, makeSession, readSession, requireUser, allowed, b64u,
  useQuota, quotaOr429, claude, extractJson, MODELS, gmailSend
};
