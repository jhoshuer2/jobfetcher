// Job pool (shared by everyone), per-person filtering, scoring and application drafting.
const { db, claude, extractJson, MODELS, useQuota, today, pipe, spendDraft, refundDraft } = require('./_lib');

const DAY = 864e5, HOUR = 3600e3, WINDOW = 10, POOL_TTL = 2 * HOUR;

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

/* ---------------- where each person wants to work ---------------- */
const CC = { nigeria: 'ng', 'south africa': 'za', kenya: 'ke', ghana: 'gh', egypt: 'eg', morocco: 'ma', rwanda: 'rw', uganda: 'ug', tanzania: 'tz', ethiopia: 'et',
  sweden: 'se', norway: 'no', denmark: 'dk', finland: 'fi', 'united kingdom': 'gb', uk: 'gb', england: 'gb', scotland: 'gb', ireland: 'ie', germany: 'de', france: 'fr', spain: 'es',
  portugal: 'pt', italy: 'it', netherlands: 'nl', belgium: 'be', austria: 'at', switzerland: 'ch', poland: 'pl', 'united states': 'us', usa: 'us', us: 'us', canada: 'ca',
  mexico: 'mx', brazil: 'br', india: 'in', singapore: 'sg', australia: 'au', 'new zealand': 'nz', uae: 'ae', 'united arab emirates': 'ae', 'saudi arabia': 'sa', qatar: 'qa' };
const COUNTRY_OF = Object.fromEntries(Object.entries(CC).map(([n, c]) => [c, n]).reverse());
function parsePlace(raw, homeCC) {
  const parts = String(raw || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  if (parts.length === 1 && CC[last]) return { label: raw, city: '', country: last, cc: CC[last] };
  if (parts.length === 1) return { label: raw, city: last, country: COUNTRY_OF[homeCC] || '', cc: homeCC || '' };
  return { label: raw, city: parts[0], country: last, cc: CC[last] || homeCC || '' };
}
// modes: remote / hybrid / onsite; places: where local (hybrid/onsite) jobs may be; countries: where remote jobs must accept
function wants(profile) {
  const home = String(profile.country || 'Nigeria').toLowerCase().trim(), homeCC = CC[home] || '';
  const modes = [].concat(profile.workModes || []).map(m => String(m).toLowerCase()).map(m => /on-?site|office|in[- ]person/.test(m) ? 'onsite' : /hybrid/.test(m) ? 'hybrid' : /remote/.test(m) ? 'remote' : '').filter(Boolean);
  const places = [].concat(profile.places && profile.places.length ? profile.places : [profile.country || 'Nigeria']).map(p => parsePlace(p, homeCC)).filter(Boolean).slice(0, 6);
  const countries = [...new Set([home, ...places.map(p => p.country)].filter(Boolean))];
  return { modes: modes.length ? [...new Set(modes)] : ['remote'], places, countries, home, homeCC };
}
const isRemoteJob = j => j.remote != null ? !!j.remote : !/\b(on-?site|in[- ]office|hybrid)\b/i.test(String(j.location || ''));
const isHybrid = j => /\bhybrid\b/i.test(String(j.location || '') + ' ' + String(j.type || '') + ' ' + String(j.text || '').slice(0, 1200));
// Can this person take this job, given where it is and how it's worked?
function placeFit(job, w) {
  if (isRemoteJob(job)) {
    if (!w.modes.includes('remote')) return 'no';
    return eligibility(job, w.home);   // remote rules are about where the person lives
  }
  const mode = isHybrid(job) ? 'hybrid' : 'onsite';
  if (!w.modes.includes(mode) && !(mode === 'hybrid' && w.modes.includes('onsite'))) return 'no';
  const loc = (String(job.location || '') + ' ' + (COUNTRY_OF[job.cc] || '')).toLowerCase();
  return w.places.some(p => p.city ? loc.includes(p.city) : (p.country && (loc.includes(p.country) || (job.cc && job.cc === p.cc)))) ? 'yes' : 'no';
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
    return (d.jobs || []).map(j => ({
      title: j.title, company: name, url: j.jobUrl || j.applyUrl, posted: j.publishedAt,
      location: (l => l + (j.isRemote && !/remote/i.test(l) ? (l ? ' · ' : '') + 'Remote' : ''))([j.location].concat((j.secondaryLocations || []).map(x => x.location || x)).filter(Boolean).join(' · ')),
      type: j.employmentType || '', payText: j.compensation && (j.compensation.compensationTierSummary || j.compensation.scrapeableCompensationSalarySummary) || '',
      remote: !!(j.isRemote || j.workplaceType === 'Remote' || remoteOk(j.location)), text: (j.descriptionPlain || strip(j.descriptionHtml)), source: 'Startup boards', applyVia: 'form' }));
  }
  if (ats === 'greenhouse') {
    const d = await getRaw(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
    return (d.jobs || []).map(j => ({ title: j.title, company: j.company_name || name, url: j.absolute_url, posted: j.first_published || j.updated_at, location: (j.location && j.location.name) || '', remote: remoteOk(j.location && j.location.name), text: strip(j.content), source: 'Startup boards', applyVia: 'form' }));
  }
  if (ats === 'lever') {
    const d = await getRaw(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
    return (Array.isArray(d) ? d : []).map(j => ({
      title: j.text, company: name, url: j.hostedUrl, posted: j.createdAt, location: [(j.categories || {}).location, j.workplaceType === 'remote' ? 'Remote' : ''].filter(Boolean).join(' · '),
      type: (j.categories || {}).commitment || '', pay: j.salaryRange && j.salaryRange.min ? { min: j.salaryRange.min, max: j.salaryRange.max, cur: j.salaryRange.currency || 'USD', period: periodFrom(j.salaryRange.interval) || 'year' } : null,
      remote: remoteOk(j.categories && j.categories.location, j.workplaceType === 'remote'), text: j.descriptionPlain || '', source: 'Startup boards', applyVia: 'form' }));
  }
  return [];
}

const CUR_OF = { gb: 'GBP', us: 'USD', ca: 'CAD', au: 'AUD', nz: 'AUD', za: 'ZAR', ng: 'NGN', se: 'SEK', no: 'NOK', dk: 'DKK', ch: 'CHF', pl: 'PLN', in: 'INR', br: 'BRL', mx: 'MXN' };
const ADZUNA_CC = new Set(['gb', 'us', 'at', 'au', 'be', 'br', 'ca', 'ch', 'de', 'es', 'fr', 'in', 'it', 'mx', 'nl', 'nz', 'pl', 'sg', 'za']);
const CAREERJET_LOCALE = { ng: 'en_NG', za: 'en_ZA', ke: 'en_KE', gh: 'en_GH', eg: 'en_EG', gb: 'en_GB', ie: 'en_IE', us: 'en_US', ca: 'en_CA', au: 'en_AU', nz: 'en_NZ', in: 'en_IN', sg: 'en_SG', ae: 'en_AE', sa: 'en_SA', qa: 'en_QA',
  se: 'sv_SE', no: 'no_NO', dk: 'da_DK', fi: 'fi_FI', de: 'de_DE', at: 'de_AT', ch: 'de_CH', fr: 'fr_FR', be: 'fr_BE', nl: 'nl_NL', es: 'es_ES', pt: 'pt_PT', it: 'it_IT', pl: 'pl_PL', br: 'pt_BR', mx: 'es_MX' };
const periodWord = w => ({ YEAR: 'year', MONTH: 'month', WEEK: 'week', DAY: 'day', HOUR: 'hour', Y: 'year', M: 'month', W: 'week', D: 'day', H: 'hour' })[String(w || '').toUpperCase()] || null;
// Searches for the local / multi-country platforms: role × place, shared across everyone, newest needs first.
function plan(profiles) {
  const out = [], seen = new Set();
  for (const p of profiles) {
    const w = wants(p), roles = targets(p).roles.slice(0, 3);
    const spots = w.modes.some(m => m !== 'remote') ? w.places : [];
    for (const r of roles) {
      for (const pl of spots) { const k = r + '|' + pl.city + '|' + pl.cc; if (!seen.has(k)) { seen.add(k); out.push({ q: r, city: pl.city, country: pl.country, cc: pl.cc, remote: false }); } }
      if (w.modes.includes('remote')) for (const c of w.countries.slice(0, 3)) { const cc = CC[c] || ''; const k = r + '|remote|' + cc; if (!seen.has(k)) { seen.add(k); out.push({ q: r, city: '', country: c, cc, remote: true }); } }
    }
  }
  return out.slice(0, 24);
}
async function jsearch(s, freshest) {
  const key = process.env.JSEARCH_API_KEY, host = process.env.JSEARCH_HOST || 'api.openwebninja.com';
  const rapid = /rapidapi/.test(host);
  const qs = new URLSearchParams({ query: s.remote ? `${s.q} remote` : `${s.q} in ${s.city || s.country}`, page: '1', num_pages: '1', date_posted: freshest ? 'today' : '3days' });
  if (s.cc) qs.set('country', s.cc);
  if (s.remote) qs.set('work_from_home', 'true');
  const url = rapid ? `https://${host}/search?${qs}` : `https://${host}/jsearch/search?${qs}`;
  const r = await fetch(url, { headers: rapid ? { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': host } : { 'x-api-key': key }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  return (d.data || []).map(j => {
    const opts = Array.isArray(j.apply_options) ? j.apply_options : [];
    const direct = opts.find(o => o && o.is_direct) || null;
    return { title: j.job_title, company: j.employer_name, url: (direct && direct.apply_link) || j.job_apply_link || j.job_google_link,
      posted: j.job_posted_at_timestamp || j.job_posted_at_datetime_utc, location: [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ') || (j.job_is_remote ? 'Remote' : ''),
      remote: !!j.job_is_remote, cc: String(j.job_country || s.cc || '').toLowerCase(), type: j.job_employment_type || '',
      pay: j.job_min_salary ? { min: j.job_min_salary, max: j.job_max_salary || j.job_min_salary, cur: j.job_salary_currency || 'USD', period: periodWord(j.job_salary_period) || 'year' } : null,
      listedOn: [...new Set([j.job_publisher, ...opts.map(o => o && o.publisher)].filter(Boolean))], text: String(j.job_description || ''), source: j.job_publisher || 'Google for Jobs' };
  });
}
async function adzuna(s) {
  const qs = new URLSearchParams({ app_id: process.env.ADZUNA_APP_ID, app_key: process.env.ADZUNA_APP_KEY, what: s.q, max_days_old: '10', sort_by: 'date', results_per_page: '50', 'content-type': 'application/json' });
  if (s.city) qs.set('where', s.city);
  const d = await getRaw(`https://api.adzuna.com/v1/api/jobs/${s.cc}/search/1?${qs}`);
  return (d.results || []).map(j => ({ title: strip(j.title), company: (j.company || {}).display_name || 'Unknown', url: j.redirect_url, posted: j.created,
    location: (j.location || {}).display_name || '', cc: s.cc, remote: /\bremote\b/i.test((j.title || '') + ' ' + (j.description || '')) && !/hybrid/i.test(j.description || ''),
    type: [j.contract_time, j.contract_type].filter(Boolean).join(', ').replace(/_/g, ' '),
    pay: j.salary_min ? { min: j.salary_min, max: j.salary_max || j.salary_min, cur: CUR_OF[s.cc] || 'USD', period: 'year' } : null, text: strip(j.description), source: 'Adzuna' }));
}
async function careerjet(s) {
  const qs = new URLSearchParams({ locale_code: CAREERJET_LOCALE[s.cc] || 'en_GB', keywords: s.remote ? s.q + ' remote' : s.q, sort: 'date', page_size: '50',
    user_ip: process.env.CAREERJET_USER_IP || '102.89.0.1', user_agent: 'Mozilla/5.0 (compatible; Radar/1.0)' });
  if (s.city) qs.set('location', s.city);
  const r = await fetch(`https://search.api.careerjet.net/v4/query?${qs}`, { headers: { Authorization: 'Basic ' + Buffer.from(process.env.CAREERJET_API_KEY + ':').toString('base64'), Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  return (d.jobs || []).map(j => ({ title: strip(j.title), company: j.company || 'Unknown', url: j.url, posted: j.date, location: j.locations || '', cc: s.cc,
    remote: /\bremote\b/i.test((j.title || '') + ' ' + (j.locations || '')) && !/hybrid/i.test(j.description || ''),
    pay: j.salary_min ? { min: +j.salary_min, max: +(j.salary_max || j.salary_min), cur: j.salary_currency_code || CUR_OF[s.cc] || 'USD', period: periodWord(j.salary_type) || 'year' } : parsePayText(j.salary),
    text: strip(j.description), source: 'Careerjet' }));
}
// Run up to `cap` searches against one platform; failures don't stop the others.
async function across(list, cap, fn) {
  const res = await Promise.allSettled(list.slice(0, cap).map(fn));
  const ok = res.filter(r => r.status === 'fulfilled');
  if (list.length && !ok.length) throw (res[0] && res[0].reason) || new Error('failed');
  return ok.flatMap(r => r.value);
}

function sources(queries, boards, searches = [], opts = {}) {
  const enc = encodeURIComponent;
  const S = {
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
    },
    // Europe (mostly Germany): free, no key
    'Arbeitnow': () => many(['https://www.arbeitnow.com/api/job-board-api'], d => (d.data || []).map(j => ({ title: j.title, company: j.company_name, url: j.url, posted: j.created_at,
      location: j.location || '', remote: !!j.remote, cc: j.remote ? '' : 'de', type: [].concat(j.job_types || []).join(', '), text: [].concat(j.tags || []).join(' ') + ' ' + strip(j.description), source: 'Arbeitnow' })))
  };
  // Sweden's public employment service: free, no key, only when someone wants Sweden
  const se = searches.filter(s => s.cc === 'se');
  if (se.length) S['Platsbanken'] = () => across([...new Set(se.map(s => s.q))].map(q => ({ q })), 4, async s => {
    const since = new Date(Date.now() - 10 * DAY).toISOString().slice(0, 19);
    const d = await getRaw(`https://jobsearch.api.jobtechdev.se/search?q=${enc(s.q)}&published-after=${since}&limit=100&sort=pubdate-desc`);
    return (d.hits || []).map(j => { const a = j.workplace_address || {}; const desc = (j.description && (j.description.text || j.description.text_formatted)) || '';
      return { title: j.headline, company: (j.employer || {}).name || 'Unknown', url: j.webpage_url || (j.application_details || {}).url, posted: j.publication_date,
        location: [a.municipality || a.city, a.region, 'Sweden'].filter(Boolean).join(', '), cc: 'se', remote: !!j.remote_work || /\b(distans|remote)\b/i.test(desc) && !/hybrid/i.test(desc),
        type: (j.employment_type || {}).label || '', text: strip(desc), source: 'Platsbanken' }; });
  });
  // Keyed platforms switch on when their key is set in Vercel
  const local = searches.filter(s => s.cc);
  if (process.env.JSEARCH_API_KEY && opts.jsearchCalls > 0) S['Google for Jobs'] = () => across(searches, opts.jsearchCalls, s => jsearch(s, opts.freshest));
  if (process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY) { const a = local.filter(s => ADZUNA_CC.has(s.cc)); if (a.length) S['Adzuna'] = () => across(a, 8, adzuna); }
  if (process.env.CAREERJET_API_KEY) { const c = local.filter(s => CAREERJET_LOCALE[s.cc]); if (c.length) S['Careerjet'] = () => across(c, 8, careerjet); }
  return S;
}
const REMOTE_BOARDS = new Set(['Remotive', 'Jobicy', 'Remote OK', 'Himalayas', 'We Work Remotely', 'Working Nomads']);

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
    const searches = plan(profiles);
    // JSearch's free plan is 200 calls a month: spend a small daily budget, freshest needs first
    const budget = Math.max(0, +(process.env.JSEARCH_DAILY || 6));
    let jsearchCalls = 0;
    if (process.env.JSEARCH_API_KEY && searches.length && budget) {
      const used = +(await db.redis('GET', 'jsearch:' + today())) || 0;
      jsearchCalls = Math.max(0, Math.min(budget - used, Math.ceil(budget / 4), searches.length));
      if (jsearchCalls) await pipe([['INCRBY', 'jsearch:' + today(), jsearchCalls], ['EXPIRE', 'jsearch:' + today(), 172800]]);
    }
    const freshest = profiles.some(p => +p.freshDays === 1);
    const S = sources(queries, boardSpecs, searches, { jsearchCalls, freshest });
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
          const remote = j.remote != null ? !!j.remote : REMOTE_BOARDS.has(j.source) ? true : undefined;
          const rec = prev ? { ...prev } : { key, title, company, url: j.url, location: j.location || '', restrictions: j.restrictions, type: j.type || '', pay: j.pay || parsePayText(j.payText), text, ads: [], sources: [], listedOn: [], applyVia: j.applyVia || '', remote, cc: j.cc || '' };
          rec.postedAt = Math.max(+rec.postedAt || 0, d.getTime());
          rec.listedOn = [...new Set([...(rec.listedOn || []), ...(j.listedOn || [j.source])])].slice(0, 12);
          if (rec.remote === undefined && remote !== undefined) rec.remote = remote;
          if (!rec.cc && j.cc) rec.cc = j.cc;
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
    const m = { at: Date.now(), sources: stats, size: Object.keys(existing).length + entries.filter(([k]) => !existing[k]).length - old.length, queries, searches: searches.length, jsearchCalls };
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
  const t = targets(u.profile), w = wants(u.profile), floor = +u.profile.minMonthlyUSD || 1000;
  const fresh = [1, 3, 10].includes(+u.settings.freshDays) ? +u.settings.freshDays : [1, 3, 10].includes(+u.profile.freshDays) ? +u.profile.freshDays : WINDOW;
  return Object.values(pool).map(j => {
    const last = j.ads[j.ads.length - 1];
    const hours = j.postedAt ? Math.max(0, Math.floor((Date.now() - j.postedAt) / HOUR)) : ageDays(last) * 24;
    const reach = (j.listedOn && j.listedOn.length) || (j.sources || []).length || 1;
    return { ...j, last, first: j.ads[0], age: ageDays(last), hours, reach, early: hours <= 24 && reach <= 2, re: j.ads.length > 1, monthly: monthlyUSD(j.pay), elig: placeFit(j, w), mode: isRemoteJob(j) ? 'remote' : isHybrid(j) ? 'hybrid' : 'onsite' };
  }).filter(j => (fresh === WINDOW ? j.age <= WINDOW : j.hours <= fresh * 24) && j.elig !== 'no' && !(j.monthly != null && j.monthly < floor) && titleFits(j.title, t) && !(u.apps[j.key] && DONE.has(u.apps[j.key].status)));
}
async function scoreFor(uid, u, jobs, deadline) {
  const todo = jobs.filter(j => !(u.matches[j.key] && u.matches[j.key].pv === u.pv)).slice(0, 60);
  let n = 0, lastErr = '';
  for (let i = 0; i < todo.length && Date.now() < deadline - 12000; i += 20) {
    const batch = todo.slice(i, i + 20);
    if (!(await useQuota(uid, 'score', batch.length))) { lastErr = 'limit'; break; }
    // Short ids: the model echoes "j3" reliably; long company|title keys sometimes come back altered and get lost.
    const idOf = new Map(batch.map((j, k) => ['j' + (k + 1), j.key]));
    let text = '';
    try { text = await claude({
      model: MODELS.match(),
      system: `You are a strict, honest recruiter. Score how well each job fits the candidate (0-100).
90+: near-perfect fit on role, seniority, skills and work type. 75-89: strong fit, small gaps. 50-74: stretch. <50: poor fit.
Penalise: different role family, seniority mismatch, missing core skills, pay below their minimum, location rules that exclude them (they live in ${u.profile.country || 'unknown'}; they want ${(wants(u.profile).modes).join('/')} work${wants(u.profile).places.length ? ' in ' + wants(u.profile).places.map(p => p.label).join('; ') : ''}), work types they ruled out, dealbreakers.
"why": max 18 words, specific (name the matching skill/project). "gaps": max 14 words or "".`,
      messages: [{ role: 'user', content: `Candidate profile:\n${JSON.stringify(u.profile).slice(0, 6000)}\n\nJobs:\n${JSON.stringify(batch.map(j => ({ id: j.key, title: j.title, company: j.company, location: j.location, type: j.type, pay: j.monthly ? `~$${j.monthly}/month` : 'not stated', work: j.mode, snippet: String(j.text || '').slice(0, 900) })).map((x, k) => ({ ...x, id: 'j' + (k + 1) })))}\n\nReturn ONLY a JSON array: [{"id":"j1","score":0,"why":"...","gaps":"..."}], one per job, using the ids given.` }],
      maxTokens: 3000
    }); } catch (e) { lastErr = e.message; await pipe([['DECRBY', `use:${uid}:score:${today()}`, batch.length]]).catch(() => {}); continue; }
    let arr = extractJson(text);
    if (arr && !Array.isArray(arr) && typeof arr === 'object') arr = Object.values(arr).find(Array.isArray) || null;
    if (!Array.isArray(arr)) { lastErr = 'Scoring reply was unreadable'; await pipe([['DECRBY', `use:${uid}:score:${today()}`, batch.length]]).catch(() => {}); continue; }
    const out = {};
    arr.forEach((r, k) => { const key = r && (idOf.get(String(r.id).trim().toLowerCase()) || (arr.length === batch.length ? batch[k].key : null)); if (key) out[key] = { score: Math.max(0, Math.min(100, Math.round(+r.score || 0))), why: String(r.why || '').slice(0, 200), gaps: String(r.gaps || '').slice(0, 160), pv: u.pv, at: Date.now() }; });
    if (Object.keys(out).length) { Object.assign(u.matches, out); await db.hset('matches:' + uid, out); n += Object.keys(out).length; }
  }
  scoreFor.lastErr = n ? '' : lastErr;
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
  return { scored, drafted, error: scoreFor.lastErr || '' };
}

// What the Matches screen shows: strong matches only, with application status.
async function feed(uid) {
  const [u, pool, meta, boards] = await Promise.all([loadUser(uid), db.hgetall('pool'), db.get('pool:meta'), db.get('pool:boards')]);
  const cands = candidates(pool, u);
  const pending = cands.filter(j => !(u.matches[j.key] && u.matches[j.key].pv === u.pv)).length;
  const strong = cands.filter(j => { const m = u.matches[j.key]; return m && m.pv === u.pv && m.score >= Math.min(60, u.settings.threshold); })   // client filters by the chosen level and counts each one
    .map(j => ({ key: j.key, title: j.title, company: j.company, url: j.url, location: j.location, elig: j.elig, type: j.type, pay: j.pay, monthly: j.monthly, ads: j.ads, age: j.age, hours: j.hours, reach: j.reach, early: j.early, listedOn: j.listedOn || j.sources, mode: j.mode, re: j.re, sources: j.sources, snippet: String(j.text || '').slice(0, 220), match: u.matches[j.key], app: u.apps[j.key] ? { status: u.apps[j.key].status, method: u.apps[j.key].method } : null }))
    .sort((a, b) => b.match.score - a.match.score || a.hours - b.hours);
  const apps = Object.values(u.apps).sort((a, b) => (b.sentAt || b.createdAt) - (a.sentAt || a.createdAt));
  const waiting = cands.filter(j => !(u.matches[j.key] && u.matches[j.key].pv === u.pv)).slice(0, 24)
    .map(j => ({ key: j.key, title: j.title, company: j.company, url: j.url, location: j.location, monthly: j.monthly, age: j.age, hours: j.hours, mode: j.mode }));
  return { jobs: strong, pending, waiting, apps, meta: meta || {}, boards: boards || {}, threshold: u.settings.threshold, fresh: [1, 3, 10].includes(+u.settings.freshDays) ? +u.settings.freshDays : (u.profile && +u.profile.freshDays) || 10, hasProfile: !!u.profile };
}

module.exports = { refreshPool, processUser, feed, loadUser, draftFor, candidates, targets, eligibility, monthlyUSD, DEFAULT_BOARDS, today, wants, placeFit, plan };
