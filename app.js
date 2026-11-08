/* Radar — app shell: sign-in state, routing, Matches, Review, Applied, Settings. radar.js handles the interview. */
(function(){
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ls = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) }catch(e){ return d } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)) }catch(e){} }
};
const HOSTED = /^https?:$/.test(location.protocol);
const fmtDate = ds => { const [y,m,d] = String(ds).split('-').map(Number); return new Date(y,m-1,d).toLocaleDateString(undefined,{day:'numeric',month:'short'}) };
const ago = t => { if(!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m/60) + ' h ago' : Math.round(m/1440) + ' d ago' };
function toast(t){ const el = document.createElement('div'); el.className = 'toast'; el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 3200) }

/* ---------- API ---------- */
async function api(path, body, {raw = false, timeout = 60000, method} = {}){
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  try{
    const r = await fetch('/api/' + path, body === undefined ? {method: method || 'GET', signal: ctl.signal, cache:'no-store'} : {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body), signal:ctl.signal});
    if(!r.ok){
      const j = await r.json().catch(() => ({}));
      if(r.status === 401){ JR.me = null; route(); }
      const e = new Error(j.error === 'not_configured' ? `This site isn't fully set up yet (missing ${j.missing}).` : j.error === 'not_invited' ? 'Your email isn\'t on the invite list yet.' : j.error === 'signed_out' ? 'Please sign in again.' : (j.error || ('HTTP ' + r.status)));
      e.code = j.code || j.error; throw e;
    }
    return raw ? r : r.json();
  } catch(e){ if(e.name === 'AbortError') throw new Error('That took too long. Try again.'); throw e }
  finally { clearTimeout(t) }
}

/* ---------- state ---------- */
const JR = window.JR = { api, esc, ls, toast, me: null, feed: null, HOSTED };
JR.profile = () => JR.me && JR.me.profile;
JR.setProfile = async p => { const r = await api('me', {action:'profile', profile:p}); JR.me.profile = p; JR.me.pv = r.pv; JR.feed = null; };
JR.saveRadar = (() => { let t = null; return radar => { if(!JR.me) return; JR.me.radar = radar; clearTimeout(t); t = setTimeout(() => api('me', {action:'radar', radar}).catch(() => {}), 600) } })();
JR.saveCv = async (file) => {
  const b64 = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(file) });
  const mime = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name) ? 'application/pdf' : 'text/plain';
  await api('me', {action:'cv', name:file.name, mime, b64});
  JR.me.cv = {name:file.name, mime, size:file.size, at:Date.now()};
};

/* ---------- routing ---------- */
const VIEWS = ['radar','matches','review','applied','settings','credits'];
function route(){
  let v = (location.hash || '').slice(1);
  if(['not-invited','signin-failed','signin-cancelled'].includes(v)){ showLanding(v); return }
  const signed = !!JR.me;
  // Until the first interview is done, Radar is the only thing on screen: no menu, no credits.
  const focus = signed && !JR.profile();
  $('nav').hidden = !signed || focus; $('me').hidden = !signed; $('creditPill').hidden = !signed || focus;
  if(signed){
    let m;
    if((m = v.match(/^credits-ok-(\d+)$/))){ refreshBalance(); toast(`Payment received: ${m[1]} credits added.`); history.replaceState(null, '', '#credits'); v = 'credits' }
    else if(v === 'credits-failed'){ toast('That payment didn\'t go through. You haven\'t been charged credits.'); history.replaceState(null, '', '#credits'); v = 'credits' }
    else if(v === 'settings-gmail-on'){ JR.me.user.gmailOk = true; toast('Gmail connected. Approved emails now send with one tap.'); history.replaceState(null, '', '#settings'); v = 'settings' }
    updateCredits();
  }
  if(!signed){ showLanding(); return }
  if(!VIEWS.includes(v)) v = JR.profile() && JR.me.radar && JR.me.radar.done ? 'matches' : 'radar';
  if(!JR.profile() && v !== 'radar' && v !== 'settings') v = 'radar';
  VIEWS.forEach(x => $('view-' + x).hidden = x !== v);
  document.querySelectorAll('.nav a').forEach(a => a.setAttribute('aria-current', a.dataset.view === v ? 'page' : 'false'));
  if(v === 'radar' && window.Radar) window.Radar.show();
  if(v === 'matches') showMatches();
  if(v === 'review') renderReview();
  if(v === 'applied') renderApplied();
  if(v === 'settings') renderSettings();
  if(v === 'credits') renderCredits();
}
function showLanding(reason){
  VIEWS.forEach(x => $('view-' + x).hidden = x !== 'radar');
  ['intake','call','profile'].forEach(x => $('r-' + x).hidden = true);
  $('r-landing').hidden = false; $('nav').hidden = true; $('me').hidden = true;
  const msg = {
    'not-invited': 'That Google account isn\'t on the invite list yet. Ask the person who shared Radar to add your email.',
    'signin-failed': 'Sign-in didn\'t complete. Please try again.',
    'signin-cancelled': 'Sign-in was cancelled.'
  }[reason];
  $('landingMsg').innerHTML = msg ? `<p class="msg err">${esc(msg)}</p>` : (!HOSTED ? '<p class="msg warn">Open the live site to sign in.</p>' : '');
  if(window.Radar) window.Radar.landingOrb();
}

/* ---------- Credits ---------- */
const money = (n, cur) => { try{ return new Intl.NumberFormat(undefined, {style:'currency', currency:cur, maximumFractionDigits:0}).format(n) }catch(e){ return cur + ' ' + n } };
function creditText(b){ if(!b) return ''; if(b.owner) return 'Unlimited'; if(b.credits) return b.credits + (b.credits === 1 ? ' credit' : ' credits') + (b.freeLeft ? ` + ${b.freeLeft} free` : ''); return b.freeLeft ? `${b.freeLeft} free left` : '0 credits' }
function updateCredits(){ const b = JR.me && JR.me.balance; const el = $('creditPill'); if(!b){ el.hidden = true; return } el.textContent = creditText(b); el.className = 'pill ' + (b.owner || b.credits || b.freeLeft ? 'can' : 're') }
async function refreshBalance(){ try{ const me = await api('me'); JR.me.balance = me.balance; updateCredits() }catch(e){} }
JR.setBalance = b => { if(b && JR.me){ JR.me.balance = b; updateCredits() } };
async function renderCredits(){
  let d;
  try{ d = await api('pay/packs') }catch(e){ $('creditMsg').innerHTML = `<p class="msg err">${esc(e.message)}</p>`; return }
  JR.setBalance(d.balance);
  const b = d.balance;
  $('balanceStats').innerHTML = b.owner ? '<div class="stat"><b>∞</b><span>Owner, unlimited</span></div>' :
    `<div class="stat"><b>${b.freeLeft}</b><span>Free applications left (of ${b.free})</span></div><div class="stat"><b>${b.credits}</b><span>Paid credits</span></div>`;
  $('creditMsg').innerHTML = d.enabled ? '' : '<p class="msg warn">Payments aren\'t switched on for this site yet.</p>';
  const per = p => money(Math.round(p.amount / p.apps), d.currency);
  $('packGrid').innerHTML = d.packs.map((p, i) => `<article class="card"${i === 1 ? ' style="border-color:var(--teal)"' : ''}>
      <div class="row" style="min-height:24px">${i === 1 ? '<span class="pill can">Most popular</span>' : ''}</div>
      <h3>${esc(p.label || p.apps + ' applications')}</h3>
      <div style="font:700 32px/1 'Space Grotesk',sans-serif;letter-spacing:-.02em">${esc(money(p.amount, d.currency))}</div>
      <p class="muted" style="margin:0">${p.apps} applications · ${esc(per(p))} each</p>
      <div class="actions"><button class="btn ${i === 1 ? 'teal' : 'primary'}" data-buy="${esc(p.id)}" ${d.enabled ? '' : 'disabled'}><span class="spin"></span>Buy ${p.apps} credits</button></div></article>`).join('');
  $('orderList').innerHTML = d.orders.length ? d.orders.map(o => `<div class="li"><div><h4>${o.apps} credits</h4><div class="co">${esc(money(o.amountMinor / 100, o.currency))} · ${new Date(o.paidAt).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})}</div></div><span class="pill pay">Paid</span></div>`).join('') : '<p class="muted">No purchases yet.</p>';
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-buy]'); if(!b) return;
  b.disabled = true; b.classList.add('loading');
  try{ const {url} = await api('pay/init', {pack:b.dataset.buy}); location.href = url }
  catch(err){ toast(err.message); b.disabled = false; b.classList.remove('loading') }
});

/* ---------- Matches ---------- */
let syncing = false;
async function loadFeed(){ JR.feed = await api('jobs'); updateBadge(); return JR.feed }
async function sync(force){
  if(syncing) return; syncing = true;
  if(JR.feed) renderMatches();
  const btn = $('syncBtn'); btn.disabled = true; btn.classList.add('loading'); $('syncLabel').textContent = 'Checking…';
  $('mMsg').innerHTML = '<p class="msg info">Radar is checking job boards and scoring new roles against your profile. This can take up to a minute.</p>';
  try{
    // A pass can spend most of its time refreshing job boards and score nothing; keep going while roles are waiting,
    // and only give up after two passes in a row make no progress.
    let stuck = 0;
    for(let i = 0; i < 6; i++){
      JR.feed = await api('jobs', {action:'sync', force: !!force && i === 0}, {timeout: 70000});
      updateBadge(); renderMatches();
      if(!JR.feed.pending) break;
      if(JR.feed.ran && JR.feed.ran.refreshed) continue;
      stuck = JR.feed.ran && JR.feed.ran.scored ? 0 : stuck + 1;
      if(stuck >= 2) break;
    }
    if(JR.feed.ran && JR.feed.ran.drafted) refreshBalance();
    $('mMsg').innerHTML = JR.feed.ran && JR.feed.ran.drafted ? `<p class="msg info">${JR.feed.ran.drafted} new application${JR.feed.ran.drafted > 1 ? 's' : ''} drafted. <a href="#review">Review now</a></p>` : '';
  }catch(e){ $('mMsg').innerHTML = `<p class="msg err">${esc(e.message)}</p>` }
  finally{ syncing = false; btn.disabled = false; btn.classList.remove('loading'); $('syncLabel').textContent = 'Check now'; if(JR.feed) renderMatches() }
}
async function showMatches(){
  if(!JR.feed){ $('matchGrid').innerHTML = '<div class="empty">Loading your matches…</div>'; try{ await loadFeed() }catch(e){ $('mMsg').innerHTML = `<p class="msg err">${esc(e.message)}</p>`; return } }
  renderMatches();
  const stale = !JR.feed.meta.at || Date.now() - JR.feed.meta.at > 6*3600e3;
  if(stale || JR.feed.pending) sync();
}
function matchCard(j){
  const left = 10 - j.age, pct = Math.max(0, Math.min(100, left * 10));
  const pay = j.monthly ? `<span class="pill pay">≈ $${j.monthly.toLocaleString()}/mo</span>` : `<span class="pill nopay">Pay not listed</span>`;
  const st = j.app ? (j.app.method === 'email' ? '<span class="pill can">Draft ready · Radar can send</span>' : '<span class="pill you">Pack ready · you apply</span>') : '';
  const ageTxt = j.age === 0 ? 'Today' : j.age === 1 ? '1 day ago' : j.age + ' days ago';
  return `<article class="card">
    <div class="row">${j.age <= 1 ? '<span class="pill new">New</span>' : ''}${j.re ? '<span class="pill re">Re-advertised</span>' : ''}${st}<span class="age">${ageTxt}</span></div>
    <div><h3>${esc(j.title)}</h3><div class="co">${esc(j.company)}</div></div>
    <div class="match"><div class="score" style="--v:${j.match.score}"><span>${j.match.score}</span></div><div><p>${esc(j.match.why)}</p>${j.match.gaps ? `<p class="gap">Gap: ${esc(j.match.gaps)}</p>` : ''}</div></div>
    <div class="row">${pay}${j.elig === 'unclear' ? '<span class="pill">Check location</span>' : ''}</div>
    <dl class="meta"><dt>Where</dt><dd>${esc(j.location || 'Not stated')}</dd>${j.type ? `<dt>Type</dt><dd>${esc(j.type)}</dd>` : ''}<dt>Posted</dt><dd>${j.ads.map(fmtDate).join(' → ')} · ${esc(j.sources.join(', '))}</dd></dl>
    <div class="fresh"><div class="bar"><i class="${left <= 3 ? 'warn' : ''}" style="width:${pct}%"></i></div>${left <= 0 ? 'Leaves tomorrow' : 'Leaves in ' + left + (left === 1 ? ' day' : ' days')}</div>
    <div class="actions">
      ${j.app ? `<a class="btn teal" href="#review" data-focus="${esc(j.key)}">Review application</a>` : `<button class="btn teal" data-draft="${esc(j.key)}" title="Uses 1 credit"><span class="spin"></span>Prepare application</button>`}
      <a class="btn" href="${esc(j.url)}" target="_blank" rel="noopener">Job ↗</a>
      <button class="btn ghost" data-skip="${esc(j.key)}" title="Not for me, don't show again">Pass</button>
    </div>
  </article>`;
}
function renderMatches(){
  const f = JR.feed; if(!f) return;
  const p = JR.profile() || {};
  $('mTitle').textContent = p.name ? `${p.name.split(' ')[0]}, here are your matches` : 'Your matches';
  $('mSub').textContent = `${(p.roles || []).slice(0, 3).join(' · ') || 'Roles from your interview'} · ${p.country || ''}${p.minMonthlyUSD ? ' · $' + Number(p.minMonthlyUSD).toLocaleString() + '+/month' : ''}. Only roles that clearly fit; anything you've applied to or passed on won't come back.`;
  const th = fitLevel();
  document.querySelectorAll('#fitSeg button').forEach(b => { b.setAttribute('aria-checked', String(+b.dataset.th === th)); b.querySelector('i').textContent = f.jobs.filter(j => j.match.score >= +b.dataset.th).length });
  const jobs = f.jobs.filter(j => j.match.score >= th);
  const review = f.apps.filter(a => a.status === 'review' && a.body !== undefined).length;
  const done = f.apps.filter(a => a.status === 'sent' || a.status === 'applied').length;
  $('stats').innerHTML = [[jobs.length, 'Strong matches', '#matches'], [jobs.filter(j => j.age <= 1).length, 'New in 24h', '#matches'], [review, 'Ready to review', '#review'], [done, 'Applied', '#applied']]
    .map(([n, l, h]) => `<a class="stat" href="${h}"><b>${n}</b><span>${l}</span></a>`).join('');
  const src = f.meta.sources || {};
  $('syncbar').innerHTML = `<span>Jobs checked: <i>${esc(ago(f.meta.at))}</i></span>` + (f.pending ? `<span><i>${f.pending}</i> new roles waiting to be scored</span>` : '') +
    Object.entries(src).map(([n, s]) => s.ok ? `<span>${esc(n)} <i class="ok">✓ ${s.count}</i></span>` : `<span title="${esc(s.err)}">${esc(n)} <i class="bad">✕</i></span>`).join('') + '<span>Daily run ~7am</span>';
  const waiting = f.waiting || [];
  const scoringCard = j => `<article class="card scoring" aria-busy="${syncing}">
    <div class="row"><span class="age">${j.age === 0 ? 'Today' : j.age === 1 ? '1 day ago' : j.age + ' days ago'}</span></div>
    <div><h3>${esc(j.title)}</h3><div class="co">${esc(j.company)}</div></div>
    <div class="match"><div class="score"><span></span></div><p class="wait">${syncing ? 'Checking how well this fits you…' : 'Waiting to be scored'}</p></div>
    <div class="row">${j.monthly ? `<span class="pill pay">≈ $${j.monthly.toLocaleString()}/mo</span>` : ''}<span class="pill">${esc(j.location || 'Remote')}</span></div>
    <div class="actions"><a class="btn" href="${esc(j.url)}" target="_blank" rel="noopener">Job ↗</a></div>
  </article>`;
  const waitBlock = waiting.length ? `<div class="waiting-head">${syncing ? '<span class="spin" style="display:inline-block"></span>' : ''}Being scored · ${f.pending} role${f.pending > 1 ? 's' : ''}${!syncing ? ' · <a href="#" id="scoreMore">Score now</a>' : ''}</div><div class="grid">${waiting.map(scoringCard).join('')}</div>` : '';
  const err = !syncing && f.ran && f.ran.error && f.pending ? `<p class="msg err">Scoring paused: ${esc(f.ran.error)}</p>` : '';
  $('matchGrid').innerHTML = (jobs.length ? `<div class="grid">${jobs.map(matchCard).join('')}</div>` :
    (waiting.length ? '' : `<div class="empty">${syncing ? 'Looking for roles that fit you…' : 'No strong matches right now. Radar checks again every morning, or choose <b>Worth a look</b> to see near-misses.'}</div>`)) + err + waitBlock;
  const more = $('scoreMore'); if(more) more.onclick = e => { e.preventDefault(); sync(false) };
}
// Match level: Best fits (85+), Strong (75+), Worth a look (60+). Also sets which matches the morning run drafts for.
const fitLevel = () => { const t = +(JR.me.settings.threshold || 75); return t >= 85 ? 85 : t >= 75 ? 75 : 60 };
$('fitSeg').addEventListener('click', async e => {
  const b = e.target.closest('button[data-th]'); if(!b) return;
  const prev = JR.me.settings;
  JR.me.settings = {...prev, threshold: +b.dataset.th}; renderMatches();
  try{ const r = await api('me', {action:'settings', settings: JR.me.settings}); JR.me.settings = r.settings }catch(err){ JR.me.settings = prev; renderMatches(); toast(err.message) }
});
$('syncBtn').addEventListener('click', () => sync(true));

/* ---------- applications ---------- */
async function appAction(body){ const {app} = await api('apps', body); const f = JR.feed; if(f){ const i = f.apps.findIndex(a => a.key === app.key); i >= 0 ? f.apps[i] = app : f.apps.push(app); const j = f.jobs.find(x => x.key === app.key); if(j) j.app = {status:app.status, method:app.method}; if(['sent','applied','skipped'].includes(app.status)) f.jobs = f.jobs.filter(x => x.key !== app.key); } updateBadge(); return app }
document.addEventListener('click', async e => {
  const d = e.target.closest('[data-draft]'), s = e.target.closest('[data-skip]');
  if(d){ d.disabled = true; d.classList.add('loading');
    try{ await appAction({action:'draft', key:d.dataset.draft}); refreshBalance(); location.hash = '#review' }
    catch(err){ toast(err.message); d.disabled = false; d.classList.remove('loading'); if(err.code === 'no_credits') location.hash = '#credits' } }
  if(s){ s.disabled = true; try{ await appAction({action:'mark', key:s.dataset.skip, status:'skipped'}); renderMatches(); toast('Got it, Radar won\'t show that one again.') }catch(err){ toast(err.message); s.disabled = false } }
});
function updateBadge(){
  const n = JR.feed ? JR.feed.apps.filter(a => a.status === 'review' && a.body !== undefined).length : 0;
  $('reviewBadge').hidden = !n; $('reviewBadge').textContent = n;
}
async function renderReview(){
  if(!JR.feed) try{ await loadFeed() }catch(e){ $('reviewMsg').innerHTML = `<p class="msg err">${esc(e.message)}</p>`; return }
  const apps = JR.feed.apps.filter(a => a.status === 'review' && a.body !== undefined);
  const gmail = JR.me.user.gmailOk, cv = JR.me.cv;
  $('reviewMsg').innerHTML = !gmail ? '<p class="msg info">Email applications open in your own email, ready to send. Attach your CV before sending. Want one-tap sending with your CV attached automatically? <a href="/api/auth/gmail">Connect Gmail</a></p>' : '';
  $('reviewList').innerHTML = apps.length ? apps.map(a => {
    const m = (JR.feed.jobs.find(j => j.key === a.key) || {}).match;
    const needs = a.needsFromYou && a.needsFromYou.length ? `<div class="needs"><b>Before applying, this job asks for:</b><ul>${a.needsFromYou.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : '';
    const head = `<div class="app-head"><div><div class="row" style="margin-bottom:6px">${a.method === 'email' ? '<span class="pill can">Radar can send this</span>' : '<span class="pill you">You apply on their form</span>'}${m ? `<span class="pill">Match ${m.score}</span>` : ''}</div><h3>${esc(a.job.title)}</h3><div class="co">${esc(a.job.company)}${a.job.location ? ' · ' + esc(a.job.location) : ''}</div></div><a class="btn sm" href="${esc(a.job.url)}" target="_blank" rel="noopener">View job ↗</a></div>`;
    if(a.method === 'email'){
      const attach = !gmail ? '📎 Remember to attach your CV in your email app.' : cv && cv.mime === 'application/pdf' ? `📎 ${esc(cv.name)} will be attached` : '⚠️ No PDF CV saved, so nothing will be attached (add one in Settings)';
      const mailto = `mailto:${encodeURIComponent(a.to)}?subject=${encodeURIComponent(a.subject)}&body=${encodeURIComponent(a.body)}`;
      const gweb = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(a.to)}&su=${encodeURIComponent(a.subject)}&body=${encodeURIComponent(a.body)}`;
      return `<div class="app" data-app="${esc(a.key)}">${head}${needs}
        <div class="field"><label>To</label><input data-f="to" value="${esc(a.to)}"></div>
        <div class="field"><label>Subject</label><input data-f="subject" value="${esc(a.subject)}"></div>
        <div class="field"><label>Message</label><textarea data-f="body" style="min-height:220px">${esc(a.body)}</textarea></div>
        <p class="muted" style="font-size:13px;margin:-4px 0 14px">${attach}</p>
        <div class="row" style="gap:8px">${gmail ? `<button class="btn teal" data-send="${esc(a.key)}"><span class="spin"></span>Approve &amp; send from Gmail</button>` : `<a class="btn teal" href="${esc(mailto)}">Open in my email app</a><a class="btn" href="${esc(gweb)}" target="_blank" rel="noopener">Open in Gmail web</a><button class="btn" data-mark="applied" data-key="${esc(a.key)}">I sent it ✓</button>`}<button class="btn ghost" data-mark="skipped" data-key="${esc(a.key)}">Pass</button></div></div>`;
    }
    return `<div class="app" data-app="${esc(a.key)}">${head}${needs}
      <p class="muted" style="margin:0 0 12px;font-size:14px">This job uses an application form, so Radar can't submit it. Here's everything you need. It should take about 2 minutes.</p>
      <div class="field"><label>Cover letter <button class="copy" data-copy="coverLetter">Copy</button></label><textarea data-f="coverLetter" style="min-height:200px">${esc(a.coverLetter)}</textarea></div>
      ${(a.answers || []).map(x => `<div class="qa"><button class="copy" data-copytext="${esc(x.a)}">Copy</button><b>${esc(x.q)}</b><p>${esc(x.a)}</p></div>`).join('')}
      <div class="row" style="gap:8px;margin-top:12px"><a class="btn teal" href="${esc(a.job.url)}" target="_blank" rel="noopener">Open application ↗</a><button class="btn" data-mark="applied" data-key="${esc(a.key)}">I applied ✓</button><button class="btn ghost" data-mark="skipped" data-key="${esc(a.key)}">Pass</button></div></div>`;
  }).join('') : '<div class="empty">Nothing waiting. Radar drafts applications for your strongest matches every morning, or tap "Prepare application" on any match.</div>';
}
// save edits when a field loses focus
document.addEventListener('change', async e => {
  const f = e.target.closest('[data-f]'); if(!f) return;
  const box = f.closest('[data-app]'); const key = box.dataset.app;
  try{ await appAction({action:'update', key, fields:{[f.dataset.f]: f.value}}) }catch(err){ toast('Couldn\'t save: ' + err.message) }
});
document.addEventListener('click', async e => {
  const send = e.target.closest('[data-send]'), mark = e.target.closest('[data-mark]'), cp = e.target.closest('[data-copy],[data-copytext]');
  if(send){
    const key = send.dataset.send, box = send.closest('[data-app]');
    const fields = {}; box.querySelectorAll('[data-f]').forEach(x => fields[x.dataset.f] = x.value);
    if(!confirm(`Send this application to ${fields.to} from your Gmail now?`)) return;
    send.disabled = true; send.classList.add('loading');
    try{ await appAction({action:'update', key, fields}); await appAction({action:'send', key}); toast('Sent. It\'s in Applied now.'); renderReview() }
    catch(err){ toast(err.message); send.disabled = false; send.classList.remove('loading') }
  }
  if(mark){
    mark.disabled = true;
    try{ await appAction({action:'mark', key:mark.dataset.key, status:mark.dataset.mark}); toast(mark.dataset.mark === 'applied' ? 'Moved to Applied.' : 'Passed. It won\'t come back.'); renderReview() }
    catch(err){ toast(err.message); mark.disabled = false }
  }
  if(cp){
    e.preventDefault();
    const text = cp.dataset.copytext ?? cp.closest('.field').querySelector('textarea').value;
    try{ await navigator.clipboard.writeText(text); cp.textContent = 'Copied' }catch(_){ cp.textContent = 'Select & copy' }
    setTimeout(() => cp.textContent = 'Copy', 1600);
  }
});

/* ---------- Applied ---------- */
async function renderApplied(){
  if(!JR.feed) try{ await loadFeed() }catch(e){ return }
  const row = a => `<div class="li"><div><h4>${esc(a.job.title)}</h4><div class="co">${esc(a.job.company)} · ${a.status === 'sent' ? 'Sent from Gmail' : a.status === 'skipped' ? 'Passed' : 'You applied'}${a.sentAt ? ' · ' + new Date(a.sentAt).toLocaleDateString(undefined,{day:'numeric',month:'short'}) : ''}</div></div>
    <a class="btn sm" href="${esc(a.job.url)}" target="_blank" rel="noopener">Job ↗</a>
    ${a.body || a.coverLetter ? `<details><summary class="muted" style="cursor:pointer">What was ${a.status === 'sent' ? 'sent' : 'prepared'}</summary><pre>${esc(a.status === 'sent' || a.method === 'email' ? `To: ${a.to}\nSubject: ${a.subject}\n\n${a.body}` : a.coverLetter)}</pre></details>` : ''}</div>`;
  const done = JR.feed.apps.filter(a => a.status === 'sent' || a.status === 'applied');
  $('appliedList').innerHTML = done.length ? done.map(row).join('') : '<div class="empty">Nothing yet. Applications you send or mark as applied show up here.</div>';
  const sk = JR.feed.apps.filter(a => a.status === 'skipped');
  $('skippedList').innerHTML = sk.length ? sk.map(row).join('') : '<p class="muted">None.</p>';
}

/* ---------- Settings ---------- */
async function renderSettings(){
  const m = JR.me;
  $('acct').textContent = `Signed in as ${m.user.name ? m.user.name + ' · ' : ''}${m.user.email}`;
  $('gmailConnect').innerHTML = m.user.gmailOk ? '<p class="msg info" style="margin:0">✓ Connected. Approved email applications send from ' + esc(m.user.email) + ' with your CV attached.</p>' : '<a class="btn teal" href="/api/auth/gmail">Connect Gmail</a> <span class="muted" style="font-size:13px;margin-left:8px">Google will show a permission screen. You can disconnect anytime at myaccount.google.com/permissions.</span>';
  $('autoDraft').value = String(m.settings.autoDraft ?? 2);
  $('cvState').textContent = m.cv ? `CV on file: ${m.cv.name}${m.cv.mime === 'application/pdf' ? '' : ' (text only, so it can\'t be attached; upload a PDF)'}` : 'No CV saved yet.';
  $('digest').checked = m.settings.digest !== false;
  $('statusPanel').hidden = !(m.balance && m.balance.owner);
  if(m.balance && m.balance.owner) try{
    const h = await (await fetch('/api/health', {cache:'no-store'})).json();
    const li = (ok, t) => `<li>${ok ? '✅' : '⬜'} ${t}</li>`;
    $('health').innerHTML = li(h.signin, 'Google sign-in') + li(h.database, 'Database (Upstash)') + li(h.claude, 'Claude (interview, matching, drafting)') + li(h.voice, 'ElevenLabs voice') + li(h.daily, 'Daily morning run') + li(h.payments, 'Payments (Paystack)') + li(h.owner, 'Owner account (OWNER_EMAILS)') + (h.inviteOnly ? li(true, 'Invite-only (ALLOWED_EMAILS set)') : li(true, 'Open to anyone'));
  }catch(e){ $('health').innerHTML = '<li>Couldn\'t check.</li>' }
}
$('digest').addEventListener('change', async () => { try{ const r = await api('me', {action:'settings', settings:{...JR.me.settings, digest:$('digest').checked}}); JR.me.settings = r.settings; toast('Saved.') }catch(e){ toast(e.message) } });
$('autoDraft').addEventListener('change', async () => { try{ const r = await api('me', {action:'settings', settings:{...JR.me.settings, autoDraft:+$('autoDraft').value}}); JR.me.settings = r.settings; toast('Saved.') }catch(e){ toast(e.message) } });
$('cv2').addEventListener('change', async e => { const f = e.target.files[0]; if(!f) return; if(f.size > 3e6) return toast('Max 3 MB'); try{ await JR.saveCv(f); renderSettings(); toast('CV updated.') }catch(err){ toast(err.message) } });
$('editProfile').addEventListener('click', () => { window.Radar && window.Radar.editProfile() });
$('redo2').addEventListener('click', e => { e.preventDefault(); window.Radar && window.Radar.redo() });
$('wipe').addEventListener('click', async () => {
  if(!confirm('Delete your profile, interview, CV, matches and applications from Radar? This can\'t be undone.')) return;
  try{ await api('me', {action:'delete'}); JR.me = null; location.hash = ''; location.reload() }catch(e){ toast(e.message) }
});

/* ---------- theme ---------- */
$('theme').addEventListener('click', () => {
  const r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  r.dataset.theme = dark ? 'light' : 'dark'; ls.set('jobradar.theme', r.dataset.theme);
});
{ const t = ls.get('jobradar.theme', null); if(t) document.documentElement.dataset.theme = t }

/* ---------- boot ---------- */
JR.route = route;
window.addEventListener('hashchange', route);
(async () => {
  if(HOSTED){ try{ JR.me = await api('me') }catch(e){ JR.me = null } }
  if(JR.me){
    const initials = (JR.me.user.name || JR.me.user.email || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const fallback = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" fill="#13A58A"/><text x="18" y="23" font-family="Inter,Arial" font-size="14" font-weight="600" fill="#fff" text-anchor="middle">${initials.replace(/[<&>]/g, '')}</text></svg>`);
    const img = $('avatar'); img.alt = 'Account: ' + (JR.me.user.name || JR.me.user.email);
    img.onerror = () => { img.onerror = null; img.src = fallback };
    img.src = JR.me.user.picture || fallback;
  }
  route();
  if(JR.me && JR.profile()) loadFeed().catch(() => {});
})();
})();
