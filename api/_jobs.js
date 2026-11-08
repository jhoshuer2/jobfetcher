// Job pool (shared by everyone), per-person filtering, scoring and application drafting.
const { db, claude, extractJson, MODELS, useQuota, today, spendDraft, refundDraft } = require('./_lib');

const DAY = 864e5, WINDOW = 10, POOL_TTL = 6 * 3600e3;

/* ---------------- text helpers ---------------- */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = s => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e.toLowerCase()] ?? m));
const strip = s => decode(decode(String(s || '')).replace(/<[^>]+>/g, ' ')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const normKey = (co, t) => String(co || '').toLowerCase().replace(/[^a-z0-9]/g, '') + '|' + String(t || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/\b(remote|100%|worldwide|anywhere|full[- ]?time|contract)\b/g, '').replace(/[^a-z0-9]/g, '');
const dayStr = d => d.toISOString().slice(0, 10);
function toDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  let s = String(v).trim();
  if (/^\d+$/.test(s)) return toDate(+s);
  if (/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(' ', 'T');
  const d = new Date(s); return isNaN(d) ? null : d;
}
const ageDays = ds => Math.max(0, Math.floor((Date.now() - Date.parse(ds + 'T00:00:00Z')) / DAY));

/* ---------------- pay ---------------- */
const RATES = { USD: 1, EUR: 1.08, GBP: 1.27, CAD: 0.73, AUD: 0.66, CHF: 1.12, PLN: 0.25, SEK: 0.095, NOK: 0.093, DKK: 0.145, INR: 0.012, BRL: 0.18, MXN: 0.055, ZAR: 0.055, NGN: 0.00065 };
const PER = { year: 1 / 12, month: 1, week: 4.33, day: 21, hour: 160 };
function periodFrom(s) {
  s = String(s || '').toLowerCase();
  if (/hour|hr|\/h\b/.test(s)) return 'hour';
  if (/month|\bmo\b|\/m\b/.test(s)) return 'month';
  if (/week|\bwk\b/.test(s)) return 'week';
  if (/\bday|daily/.test(s)) return 'day';
  if (/year|\byr\b|annual|\bpa\b|p\.a/.test(s)) return 'year';
  return null;
}
function parsePayText(s) {
  if (!s || !/\d/.test(s)) return null;
  const low = String(s).toLowerCase();
  const cur = /€|eur/.test(low) ? 'EUR' : /£|gbp/.test(low) ? 'GBP' : /cad|ca\$/.test(low) ? 'CAD' : /aud|a\$/.test(low) ? 'AUD' : /chf/.test(low) ? 'CHF' : /pln|zł/.test(low) ? 'PLN' : /inr|₹/.test(low) ? 'INR' : 'USD';
  const nums = [...low.matchAll(/(\d[\d,]*\.?\d*)\s*(k)?/g)].map(m => parseFloat(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1)).filter(n => n > 0);
  if (!nums.length) return null;
  let period = periodFrom(low);
  const ref = nums[0];
  if (!period) period = ref >= 20000 ? 'year' : ref >= 1000 ? 'month' : ref < 300 ? 'hour' : null;
  if (!period) return null;
  return { min: nums[0], max: nums[1] || nums[0], cur, period, text: String(s).trim().slice(0, 80) };
}
function monthlyUSD(p) {
  if (!p) return null;
  const rate = RATES[(p.cur || 'USD').toUpperCase()], f = PER[p.period], v = p.min || p.max;
  return rate && f && v ? Math.round(v * rate * f) : null;
}

/* ---------------- location: can this person apply from their country? ---------------- */
const REGIONS = {
  africa: ['nigeria', 'ghana', 'kenya', 'south africa', 'egypt', 'morocco', 'rwanda', 'uganda', 'tanzania', 'ethiopia', 'cameroon', 'senegal', 'ivory coast', "côte d'ivoire", 'zambia', 'zimbabwe', 'botswana', 'tunisia', 'algeria', 'benin', 'togo'],
  europe: ['united kingdom', 'uk', 'germany', 'france', 'spain', 'portugal', 'italy', 'netherlands', 'poland', 'ireland', 'sweden', 'norway', 'denmark', 'finland', 'belgium', 'austria', 'switzerland', 'ukraine', 'romania', 'greece', 'czechia', 'hungary'],
  americas: ['united states', 'usa', 'us', 'canada', 'mexico', 'brazil', 'argentina', 'colombia', 'chile', 'peru'],
  asia: ['india', 'pakistan', 'philippines', 'indonesia', 'vietnam', 'malaysia', 'singapore', 'japan', 'china', 'bangladesh', 'sri lanka', 'thailand', 'uae', 'saudi arabia']
};
function placeTerms(country) {
  const c = String(country || 'nigeria').toLowerCase().trim();
  const terms = new Set([c, 'worldwide', 'anywhere', 'global', 'all countries', 'international', 'work from anywhere', 'any location']);
  for (const [region, list] of Object.entries(REGIONS)) if (list.includes(c)) {
    terms.add(region);
    if (region === 'africa' || region === 'europe') terms.add('emea');
    if (region === 'europe') { terms.add('eu'); terms.add('cet'); }
    if (region === 'americas') { terms.add('north america'); terms.add('latam'); }
    if (region === 'asia') terms.add('apac');
  }
  if (c === 'nigeria') { terms.add('lagos'); terms.add('abuja'); terms.add('wat'); terms.add('gmt+1'); }
  return [...terms];
}
const RESTRICT = /\b(us|usa|u\.s\.|united states|canada|uk|united kingdom|europe|eu|latam|latin america|apac|asia|india|brazil|mexico|germany|poland|philippines|australia|spain|france|portugal|argentina|americas|north america|on-?site|hybrid)\b/;
function eligibility(job, country) {
  if (Array.isArray(job.restrictions)) {
    if (!job.restrictions.length) return 'yes';
    const n = job.restrictions.map(x => typeof x === 'string' ? x : (x && (x.name || x.alpha2 || x.code)) || '').join(' ').toLowerCase();
    return placeTerms(country).some(t => n.includes(t)) ? 'yes' : 'no';
  }
  const t = String(job.location || '').toLowerCase().trim();
  if (!t) return 'unclear';
  if (placeTerms(country).some(term => new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(t))) return 'yes';
  if (RESTRICT.test(t)) return 'no';
  return 'unclear';
}

/* ---------------- what each person is looking for ---------------- */
const GENERIC = new Set(['senior', 'junior', 'lead', 'principal', 'staff', 'head', 'of', 'and', 'the', 'a', 'an', 'remote', 'mid', 'level', 'sr', 'jr', '&', '/', '-', 'i', 'ii', 'iii']);
function targets(profile) {
  const roles = [].concat(profile.roles || []).map(s => String(s).toLowerCase().trim()).filter(Boolean).slice(0, 8);
  const keywords = [].concat(profile.keywords || []).map(s => String(s).toLowerCase().trim()).filter(s => s.length > 2).slice(0, 12);
  // head nouns: the last meaningful word of each role ("product designer" → "designer")
  const heads = new Set();
  roles.forEach(r => { const w = r.split(/[\s/,-]+/).filter(x => x && !GENERIC.has(x)); if (w.length) heads.add(w[w.length - 1].replace(/s$/, '')); });
  if (roles.some(r => /\bux\b|\bui\b|user experience|product design/.test(r))) ['ux', 'ui', 'designer', 'design'].forEach(h => heads.add(h));
  return { roles, keywords, heads: [...heads] };
}
function titleFits(title, t) {
  const s = String(title || '').toLowerCase();
  if (t.roles.some(r => s.includes(r))) return true;
  return t.heads.some(h => new RegExp('\\b' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(s|er|ers)?\\b').test(s));
}

/* ---------------- sources ---------------- */
async function getRaw(url, text) {
  const r = await fetch(url, { headers: { 'User-Agent': 'JobRadar/3.0 (personal job board)', Accept: 'application/json, application/rss+xml, text/xml;q=0.9, */*;q=0.5' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return text ? r.text() : r.json();
}
async function many(urls, fn, text) {
  const res = await Promise.allSettled(urls.map(u => getRaw(u, text)));
  const ok = res.filter(r => r.status === 'fulfilled');
  if (!ok.length) throw (res[0] && res[0].reason) || new Error('failed');
  return ok.flatMap(r => fn(r.value));
}
const rssItems = xml => [...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(m => m[0]);
const tag = (item, name) => { const m = item.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim() : ''; };

const DEFAULT_BOARDS = [
  'ashby:supabase', 'ashby:posthog', 'ashby:linear', 'ashby:zapier', 'ashby:deel', 'ashby:raycast', 'ashby:replit',
  'greenhouse:gitlab', 'greenhouse:canonical', 'greenhouse:remotecom', 'greenhouse:doist', 'greenhouse:vercel', 'greenhouse:mozilla'
];
const niceName = slug => slug.replace(/[-_.]+/g, ' ').replace(/\b(com|inc|hq|careers|jobs)\b/gi, '').trim().replace(/\b\w/g, c => c.toUpperCase()) || slug;
const remoteOk = (loc, isRemote) => isRemote || /remote|anywhere|worldwide|distributed/i.test(loc || '');

async function fetchBoard(spec) {
  const [ats, slug] = spec.split(':'); const name = niceName(slug);
  if (ats === 'ashby') {
    const d = await getRaw(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`);
    return (d.jobs || []).filter(j => remoteOk(j.location, j.isRemote || j.workplaceType === 'Remote')).map(j => ({
      title: j.title, company: name, url: j.jobUrl || j.applyUrl, posted: j.publishedAt,
      location: (l => l + (j.isRemote && !/remote/i.test(l) ? (l ? ' · ' : '') + 'Remote' : ''))([j.location].concat((j.secondaryLocations || []).map(x => x.location || x)).filter(Boolean).join(' · ')),
      type: j.employmentType || '', payText: j.compensation && (j.compensation.compensationTierSummary || j.compensation.scrapeableCompensationSalarySummary) || '',
      text: (j.descriptionPlain || strip(j.descriptionHtml)), source: 'Startup boards', applyVia: 'form' }));
  }
  if (ats === 'greenhouse') {
    const d = await getRaw(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
    return (d.jobs || []).filter(j => remoteOk(j.location && j.location.name)).map(j => ({ title: j.title, company: j.company_name || name, url: j.absolute_url, posted: j.first_published || j.updated_at, location: (j.location && j.location.name) || '', text: strip(j.content), source: 'Startup boards', applyVia: 'form' }));
  }
  if (ats === 'lever') {
    const d = await getRaw(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
    return (Array.isArray(d) ? d : []).filter(j => remoteOk(j.categories && j.categories.location, j.workplaceType === 'remote')).map(j => ({
      title: j.text, company: name, url: j.hostedUrl, posted: j.createdAt, location: [(j.categories || {}).location, j.workplaceType === 'remote' ? 'Remote' : ''].filter(Boolean).join(' · '),
      type: (j.categories || {}).commitment || '', pay: j.salaryRange && j.salaryRange.min ? { min: j.salaryRange.min, max: j.salaryRange.max, cur: j.salaryRange.currency || 'USD', period: periodFrom(j.salaryRange.interval) || 'year' } : null,
      text: j.descriptionPlain || '', source: 'Startup boards', applyVia: 'form' }));
  }
  return [];
}

function sources(queries, boards) {
  const enc = encodeURIComponent;
  return {
    'Remotive': () => many(queries.map(q => `https://remotive.com/api/remote-jobs?search=${enc(q)}&limit=60`), d => (d.jobs || []).map(j => ({ title: j.title, company: j.company_name, url: j.url, posted: j.publication_date, location: j.candidate_required_location, payText: j.salary, type: (j.job_type || '').replace(/_/g, ' '), text: (j.tags || []).join(' ') + ' ' + strip(j.description), source: 'Remotive' }))),
    'Jobicy': () => many(queries.map(q => `https://jobicy.com/api/v2/remote-jobs?count=50&tag=${enc(q)}`), d => (d.jobs || []).map(j => {
      const min = +(j.salaryMin ?? j.annualSalaryMin ?? 0), max = +(j.salaryMax ?? j.annualSalaryMax ?? 0);
      return { title: j.jobTitle, company: j.companyName, url: j.url, posted: j.pubDate, location: j.jobGeo, type: [].concat(j.jobType || []).join(', '),
        pay: (min || max) ? { min, max, cur: j.salaryCurrency || 'USD', period: periodFrom(j.salaryPeriod) || (j.annualSalaryMin || min >= 20000 ? 'year' : 'month') } : null,
        text: (j.jobExcerpt || '') + ' ' + strip(j.jobDescription), source: 'Jobicy' };
    })),
    'Remote OK': () => many(['https://remoteok.com/api'], d => (Array.isArray(d) ? d : []).filter(j => j && j.position).map(j => ({ title: j.position, company: j.company, url: j.url || j.apply_url, posted: j.date || j.epoch, location: j.location, pay: j.salary_min ? { min: j.salary_min, max: j.salary_max, cur: 'USD', period: 'year' } : null, text: (j.tags || []).join(' ') + ' ' + strip(j.description), source: 'Remote OK' }))),
    'Himalayas': () => many(queries.map(q => `https://himalayas.app/jobs/api/search?q=${enc(q)}&sort=recent`), d => (d.jobs || []).map(j => ({ title: j.title, company: j.companyName, url: j.applicationLink || j.guid, posted: j.pubDate, restrictions: j.locationRestrictions || [], type: j.employmentType || '',
      pay: j.minSalary ? { min: j.minSalary, max: j.maxSalary, cur: j.currency || 'USD', period: periodFrom(j.salaryPeriod) || 'year' } : null,
      text: [].concat(j.categories || []).join(' ') + ' ' + (j.excerpt || '') + ' ' + strip(j.description), source: 'Himalayas' }))),
    'We Work Remotely': () => many(['https://weworkremotely.com/remote-jobs.rss'], xml => rssItems(xml).map(it => {
      const t = tag(it, 'title'), i = t.indexOf(':');
      return { title: i > 0 ? t.slice(i + 1).trim() : t, company: i > 0 ? t.slice(0, i).trim() : 'Unknown', url: tag(it, 'link') || tag(it, 'guid'), posted: tag(it, 'pubDate'), location: tag(it, 'region') || tag(it, 'country'), type: tag(it, 'type'), text: strip(tag(it, 'description')), source: 'We Work Remotely' };
    }), true),
    'Working Nomads': () => many(['https://www.workingnomads.com/api/exposed_jobs/'], d => (Array.isArray(d) ? d : []).map(j => ({ title: j.title, company: j.company_name, url: j.url, posted: j.pub_date, location: j.location, type: j.category_name || '', text: [j.tags, strip(j.description)].join(' '), source: 'Working Nomads' }))),
    "HN Who's hiring": async () => {
      const s = await getRaw('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=6');
      const story = (s.hits || []).find(h => /who is hiring/i.test(h.title || '')); if (!story) return [];
      const hits = await many(queries.slice(0, 6).map(q => `https://hn.algolia.com/api/v1/search?tags=comment,story_${story.objectID}&hitsPerPage=150&query=${enc(q)}`), d => d.hits || []);
      const seen = new Set();
      return hits.filter(c => String(c.parent_id) === String(story.objectID) && !seen.has(c.objectID) && seen.add(c.objectID)).map(c => {
        const html = String(c.comment_text || ''), first = strip(html.split(/<p>/i)[0]), parts = first.split(/\s*\|\s*/).filter(Boolean);
        const role = parts.slice(1).find(p => !/remote|onsite|on-site|hybrid|\$|\d{2,}k|full[- ]time|visa/i.test(p)) || parts[1] || first;
        const loc = parts.find(p => /remote|onsite|on-site|hybrid|worldwide|anywhere|global/i.test(p)) || '';
        return { title: role.slice(0, 140), company: (parts[0] || 'HN company').slice(0, 80), url: 'https://news.ycombinator.com/item?id=' + c.objectID, posted: c.created_at, location: loc, text: strip(html), source: "HN Who's hiring", payText: (first.match(/\$\s?\d[\d,.]*\s?k?(\s?[-–]\s?\$?\s?\d[\d,.]*\s?k?)?/i) || [''])[0] };
      });
    },
    'Startup boards': async () => {
      const res = await Promise.allSettled(boards.map(fetchBoard));
      const status = {}; res.forEach((r, i) => { status[boards[i]] = r.status === 'fulfilled' ? r.value.length : -1; });
      await db.set('pool:boards', status);
      return res.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
    }
  };
}

/* ---------------- the shared pool ---------------- */
// Everyone's roles decide what gets searched; every listing keeps the dates it was advertised (for the 10-day rule).
async function refreshPool({ force = false } = {}) {
  const meta = (await db.get('pool:meta')) || {};
  if (!force && meta.at && Date.now() - meta.at < POOL_TTL) return meta;
  const got = await db.redis('SET', 'pool:lock', '1', 'NX', 'EX', 90);
  if (got !== 'OK') return meta;
  try {
    const uids = await db.redis('SMEMBERS', 'users') || [];
    const profiles = (await Promise.all(uids.map(u => db.get('profile:' + u)))).filter(Boolean);
    const allT = profiles.map(targets);
    const roleQ = [...new Set(allT.flatMap(t => t.roles))].slice(0, 10);
    const queries = roleQ.length ? roleQ : ['product designer', 'ux designer'];
    const heads = [...new Set(allT.flatMap(t => t.heads))];
    const boardSpecs = [...new Set(profiles.flatMap(p => p.boards || []).concat(DEFAULT_BOARDS))].slice(0, 30);
    const S = sources(queries, boardSpecs);
    const existing = await db.hgetall('pool');
    const stats = {}; const updates = {};
    await Promise.all(Object.entries(S).map(async ([name, fn]) => {
      try {
        const raw = await fn(); let kept = 0;
        for (const j of raw) {
          if (!j || !j.title || !j.company) continue;
          const title = strip(j.title), company = strip(j.company);
          // keep only listings someone could plausibly want (their role's head noun in the title)
          if (heads.length && !titleFits(title, { roles: queries.map(q => q.toLowerCase()), heads })) continue;
          const d = toDate(j.posted); if (!d) continue;
          const key = normKey(company, title); if (key === '|') continue;
          const ad = dayStr(d);
          const prev = updates[key] || existing[key];
          const text = String(j.text || '').slice(0, 3000);
          const rec = prev ? { ...prev } : { key, title, company, url: j.url, location: j.location || '', restrictions: j.restrictions, type: j.type || '', pay: j.pay || parsePayText(j.payText), text, ads: [], sources: [], applyVia: j.applyVia || '' };
          if (!rec.ads.includes(ad)) rec.ads = [...rec.ads, ad].sort();
          if (!rec.sources.includes(j.source)) rec.sources = [...rec.sources, j.source];
          if (!rec.pay) rec.pay = j.pay || parsePayText(j.payText);
          if (!rec.text && text) rec.text = text;
          if (!rec.location && j.location) rec.location = j.location;
          updates[key] = rec; kept++;
        }
        stats[name] = { ok: true, count: kept };
      } catch (e) { stats[name] = { ok: false, err: String(e.message || e).slice(0, 120) }; }
    }));
    // write changes, prune listings not advertised for 30 days
    const old = Object.values(existing).filter(j => ageDays(j.ads[j.ads.length - 1]) > 30).map(j => j.key);
    const entries = Object.entries(updates);
    for (let i = 0; i < entries.length; i += 50) await db.hset('pool', Object.fromEntries(entries.slice(i, i + 50)));
    if (old.length) await db.hdel('pool', ...old);
    const m = { at: Date.now(), sources: stats, size: Object.keys(existing).length + entries.filter(([k]) => !existing[k]).length - old.length, queries };
    await db.set('pool:meta', m);
    return m;
  } finally { await db.del('pool:lock'); }
}

/* ---------------- one person's view ---------------- */
async function loadUser(uid) {
  const [profile, settings, pv, matches, apps, radar] = await Promise.all([
    db.get('profile:' + uid), db.get('settings:' + uid), db.get('pv:' + uid), db.hgetall('matches:' + uid), db.hgetall('apps:' + uid), db.get('radar:' + uid)
  ]);
  return { profile, settings: { threshold: 75, digest: true, autoDraft: 2, ...(settings || {}) }, pv: +pv || 0, matches, apps, radar };
}
const DONE = new Set(['sent', 'applied', 'skipped']);
// Listings this person could see: fresh (≤10 days since last advert), fits their roles, location and pay, not already handled.
function candidates(pool, u) {
  if (!u.profile) return [];
  const t = targets(u.profile), country = u.profile.country || 'Nigeria', floor = +u.profile.minMonthlyUSD || 1000;
  return Object.values(pool).map(j => {
    const last = j.ads[j.ads.length - 1];
    return { ...j, last, first: j.ads[0], age: ageDays(last), re: j.ads.length > 1, monthly: monthlyUSD(j.pay), elig: eligibility(j, country) };
  }).filter(j => j.age <= WINDOW && j.elig !== 'no' && !(j.monthly != null && j.monthly < floor) && titleFits(j.title, t) && !(u.apps[j.key] && DONE.has(u.apps[j.key].status)));
}
async function scoreFor(uid, u, jobs, deadline) {
  const todo = jobs.filter(j => !(u.matches[j.key] && u.matches[j.key].pv === u.pv)).slice(0, 60);
  let n = 0;
  for (let i = 0; i < todo.length && Date.now() < deadline - 12000; i += 20) {
    const batch = todo.slice(i, i + 20);
    if (!(await useQuota(uid, 'score', batch.length))) break;
    const text = await claude({
      model: MODELS.match(),
      system: `You are a strict, honest recruiter. Score how well each job fits the candidate (0-100).
90+: near-perfect fit on role, seniority, skills and work type. 75-89: strong fit, small gaps. 50-74: stretch. <50: poor fit.
Penalise: different role family, seniority mismatch, missing core skills, pay below their minimum, location rules that exclude the candidate's country (${u.profile.country || 'unknown'}), work types they ruled out, dealbreakers.
"why": max 18 words, specific (name the matching skill/project). "gaps": max 14 words or "".`,
      messages: [{ role: 'user', content: `Candidate profile:\n${JSON.stringify(u.profile).slice(0, 6000)}\n\nJobs:\n${JSON.stringify(batch.map(j => ({ id: j.key, title: j.title, company: j.company, location: j.location, type: j.type, pay: j.monthly ? `~$${j.monthly}/month` : 'not stated', snippet: String(j.text || '').slice(0, 900) })))}\n\nReturn ONLY a JSON array: [{"id":"...","score":0,"why":"...","gaps":"..."}], one per job.` }],
      maxTokens: 2500
    });
    let arr = extractJson(text);
    if (arr && !Array.isArray(arr) && typeof arr === 'object') arr = Object.values(arr).find(Array.isArray) || null;
    if (!Array.isArray(arr)) continue;
    const ids = new Set(batch.map(j => j.key)), out = {};
    arr.forEach(r => { if (r && ids.has(String(r.id))) out[r.id] = { score: Math.max(0, Math.min(100, Math.round(+r.score || 0))), why: String(r.why || '').slice(0, 200), gaps: String(r.gaps || '').slice(0, 160), pv: u.pv, at: Date.now() }; });
    Object.assign(u.matches, out); await db.hset('matches:' + uid, out); n += Object.keys(out).length;
  }
  return n;
}

/* ---------------- application drafts ---------------- */
const EMAIL_RX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
async function draftFor(uid, u, job, userEmail) {
  const emails = [...new Set((String(job.text || '').match(EMAIL_RX) || []).map(e => e.toLowerCase()))].filter(e => !/noreply|no-reply|example\.|privacy|gdpr|support@|accommodation/i.test(e)).slice(0, 5);
  const text = await claude({
    model: MODELS.draft(),
    system: `You write job applications for a candidate, honestly and specifically. Never invent experience, numbers, employers or skills that aren't in the profile/brief/interview.
Decide how to apply:
- "email" only if the listing clearly asks candidates to apply by emailing one of these addresses: ${JSON.stringify(emails)}. Use that exact address.
- otherwise "form" (an application page/ATS the candidate must submit themselves).
List in "needsFromYou" anything the listing demands that you cannot produce from the profile (e.g. "a short Loom video", "3 UI improvements for our site", "portfolio case study link"). Keep it empty if nothing is needed.
Email: subject ≤ 9 words; body 110-180 words, warm and direct, first person, references 1-2 concrete projects that match the role, ends with links if known, no placeholders like [Name].
Cover letter: 180-260 words. Answers: 3-5 likely form questions with concise answers (why this role, most relevant project, availability/time zone, pay expectation using the candidate's minimum).`,
    messages: [{ role: 'user', content: `Candidate profile:\n${JSON.stringify(u.profile).slice(0, 6000)}\n\nBrief from CV:\n${String(u.radar && u.radar.brief || '').slice(0, 2500)}\n\nCandidate email: ${userEmail}\n\nJob:\n${JSON.stringify({ title: job.title, company: job.company, location: job.location, pay: job.pay && job.pay.text, url: job.url, description: String(job.text || '').slice(0, 3000) })}\n\nReturn ONLY JSON: {"method":"email|form","to":"","subject":"","body":"","coverLetter":"","answers":[{"q":"","a":""}],"needsFromYou":[]}` }],
    maxTokens: 1800
  });
  const d = extractJson(text) || {};
  let method = d.method === 'email' && emails.includes(String(d.to || '').toLowerCase()) ? 'email' : 'form';
  return {
    key: job.key, status: 'review', method, to: method === 'email' ? String(d.to).toLowerCase() : '',
    subject: String(d.subject || `Application: ${job.title}`).slice(0, 140), body: String(d.body || '').slice(0, 4000),
    coverLetter: String(d.coverLetter || '').slice(0, 5000), answers: (Array.isArray(d.answers) ? d.answers : []).slice(0, 6).map(a => ({ q: String(a.q || '').slice(0, 200), a: String(a.a || '').slice(0, 1200) })),
    needsFromYou: (Array.isArray(d.needsFromYou) ? d.needsFromYou : []).slice(0, 5).map(s => String(s).slice(0, 200)),
    job: { title: job.title, company: job.company, url: job.url, location: job.location }, createdAt: Date.now()
  };
}
// Scores new listings, then drafts applications for strong matches (up to a few per run).
async function processUser(uid, deadline, { draft = true } = {}) {
  const user = await db.get('user:' + uid); if (!user) return { scored: 0, drafted: [] };
  const u = await loadUser(uid); if (!u.profile) return { scored: 0, drafted: [] };
  const pool = await db.hgetall('pool');
  const cands = candidates(pool, u);
  const scored = await scoreFor(uid, u, cands, deadline);
  const drafted = [];
  if (draft) {
    const strong = cands.filter(j => { const m = u.matches[j.key]; return m && m.pv === u.pv && m.score >= Math.max(75, u.settings.threshold) && !u.apps[j.key]; })
      .sort((a, b) => u.matches[b.key].score - u.matches[a.key].score).slice(0, Math.max(0, Math.min(5, +u.settings.autoDraft || 0)));
    for (const j of strong) {
      if (Date.now() > deadline - 15000) break;
      if (!(await useQuota(uid, 'draft'))) break;
      const source = await spendDraft(user);
      if (!source) break; // out of free applications and credits
      try { const app = await draftFor(uid, u, j, user.email); app.paidWith = source; app.auto = true; u.apps[j.key] = app; await db.hset('apps:' + uid, { [j.key]: app }); drafted.push(app); }
      catch (e) { await refundDraft(user, source); }
    }
  }
  await db.set('lastrun:' + uid, Date.now());
  return { scored, drafted };
}

// What the Matches screen shows: strong matches only, with application status.
async function feed(uid) {
  const [u, pool, meta, boards] = await Promise.all([loadUser(uid), db.hgetall('pool'), db.get('pool:meta'), db.get('pool:boards')]);
  const cands = candidates(pool, u);
  const pending = cands.filter(j => !(u.matches[j.key] && u.matches[j.key].pv === u.pv)).length;
  const strong = cands.filter(j => { const m = u.matches[j.key]; return m && m.pv === u.pv && m.score >= Math.min(60, u.settings.threshold); })   // client filters by the chosen level and counts each one
    .map(j => ({ key: j.key, title: j.title, company: j.company, url: j.url, location: j.location, elig: j.elig, type: j.type, pay: j.pay, monthly: j.monthly, ads: j.ads, age: j.age, re: j.re, sources: j.sources, snippet: String(j.text || '').slice(0, 220), match: u.matches[j.key], app: u.apps[j.key] ? { status: u.apps[j.key].status, method: u.apps[j.key].method } : null }))
    .sort((a, b) => b.match.score - a.match.score || b.ads[b.ads.length - 1].localeCompare(a.ads[a.ads.length - 1]));
  const apps = Object.values(u.apps).sort((a, b) => (b.sentAt || b.createdAt) - (a.sentAt || a.createdAt));
  return { jobs: strong, pending, apps, meta: meta || {}, boards: boards || {}, threshold: u.settings.threshold, hasProfile: !!u.profile };
}

module.exports = { refreshPool, processUser, feed, loadUser, draftFor, candidates, targets, eligibility, monthlyUSD, DEFAULT_BOARDS, today };
