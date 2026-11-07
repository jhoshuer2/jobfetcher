// Paystack credit packs.
//   GET  /api/pay/packs    → packs + your balance
//   POST /api/pay/init     → {pack} → {url} to Paystack checkout
//   GET  /api/pay/return   → Paystack sends the buyer back here (?reference=…); we verify, credit, redirect to the app
//   POST /api/pay/webhook  → Paystack's server-to-server notice (backup in case the buyer closes the tab)
// Credits are only ever added after asking Paystack directly whether the payment succeeded, and only once per reference.
const crypto = require('crypto');
const { requireUser, requireEnv, readJson, db, baseUrl, packs, CURRENCY, balance } = require('../_lib');

const PS = 'https://api.paystack.co';
const psHeaders = () => ({ Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'content-type': 'application/json' });
const redirect = (res, to) => { res.statusCode = 302; res.setHeader('Location', to); res.end(); };

async function verifyAndCredit(reference) {
  if (!/^[\w-]{6,80}$/.test(String(reference || ''))) return { ok: false, why: 'bad reference' };
  const order = await db.get('order:' + reference);
  if (!order) return { ok: false, why: 'unknown order' };
  if (order.status === 'paid') return { ok: true, already: true, order };
  const r = await fetch(`${PS}/transaction/verify/${encodeURIComponent(reference)}`, { headers: psHeaders() });
  const d = await r.json().catch(() => ({}));
  const t = d && d.data;
  if (!r.ok || !t || t.status !== 'success') return { ok: false, why: (t && t.status) || 'not paid', order };
  if (+t.amount < order.amountMinor || String(t.currency).toUpperCase() !== order.currency) return { ok: false, why: 'amount mismatch', order };
  // Only the first caller for this reference adds credits (return page and webhook can both arrive).
  const first = await db.redis('SET', 'paid:' + reference, '1', 'NX');
  if (first !== 'OK') return { ok: true, already: true, order };
  await db.redis('INCRBY', 'credits:' + order.uid, order.apps);
  Object.assign(order, { status: 'paid', paidAt: Date.now(), channel: t.channel || '' });
  await db.set('order:' + reference, order);
  await db.hset('orders:' + order.uid, { [reference]: order });
  return { ok: true, order };
}

module.exports = async (req, res) => {
  const action = req.query.action;
  res.setHeader('Cache-Control', 'no-store');

  if (action === 'webhook') {
    if (!process.env.PAYSTACK_SECRET_KEY) return res.status(200).end();
    // Signature check when the raw body is available; either way we re-verify with Paystack before crediting.
    const sig = req.headers['x-paystack-signature'];
    const body = typeof req.body === 'object' ? req.body : await readJson(req).catch(() => ({}));
    if (sig && typeof req.rawBody === 'string') {
      const good = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(req.rawBody).digest('hex');
      if (good !== sig) return res.status(401).end();
    }
    if (body && body.event === 'charge.success' && body.data && body.data.reference) await verifyAndCredit(body.data.reference).catch(() => {});
    return res.status(200).json({ received: true });
  }

  if (action === 'return') {
    const ref = req.query.reference || req.query.trxref;
    const r = await verifyAndCredit(ref).catch(() => ({ ok: false }));
    return redirect(res, r.ok ? `/#credits-ok-${r.order.apps}` : '/#credits-failed');
  }

  const user = await requireUser(req, res); if (!user) return;

  if (action === 'packs') {
    const orders = Object.values(await db.hgetall('orders:' + user.uid)).filter(o => o.status === 'paid').sort((a, b) => b.paidAt - a.paidAt).slice(0, 20);
    return res.status(200).json({ packs: packs(), currency: CURRENCY(), balance: await balance(user), orders, enabled: !!process.env.PAYSTACK_SECRET_KEY });
  }

  if (action === 'init') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (!requireEnv(res, 'PAYSTACK_SECRET_KEY')) return;
    const body = await readJson(req).catch(() => ({}));
    const pack = packs().find(p => p.id === body.pack);
    if (!pack) return res.status(400).json({ error: 'Unknown pack' });
    const reference = 'rdr_' + crypto.randomBytes(10).toString('hex');
    const amountMinor = Math.round(+pack.amount * 100);
    const order = { reference, uid: user.uid, email: user.email, pack: pack.id, apps: +pack.apps, amountMinor, currency: CURRENCY(), status: 'pending', createdAt: Date.now() };
    await db.set('order:' + reference, order);
    const r = await fetch(`${PS}/transaction/initialize`, {
      method: 'POST', headers: psHeaders(),
      body: JSON.stringify({ email: user.email, amount: amountMinor, currency: CURRENCY(), reference, callback_url: baseUrl(req) + '/api/pay/return', metadata: { uid: user.uid, pack: pack.id, apps: pack.apps } })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.status || !d.data || !d.data.authorization_url) return res.status(502).json({ error: 'Paystack: ' + ((d && d.message) || r.status) });
    return res.status(200).json({ url: d.data.authorization_url, reference });
  }

  if (action === 'verify') {
    const body = await readJson(req).catch(() => ({}));
    const order = await db.get('order:' + body.reference);
    if (!order || order.uid !== user.uid) return res.status(404).json({ error: 'No such order' });
    const r = await verifyAndCredit(body.reference);
    return res.status(200).json({ ...r, balance: await balance(user) });
  }

  return res.status(404).json({ error: 'Unknown action' });
};
