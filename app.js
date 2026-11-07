/* Job Radar — board, sources, freshness rule and match scores. Shared helpers live on window.JR for radar.js. */
(function(){
const DAY = 864e5, WINDOW = 10, MIN_MONTHLY = 1000, STORE_KEY = 'jobradar.v1', AUTO_MS = 6*3600e3;
const HOSTED = /^https?:$/.test(location.protocol);
const ls = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) }catch(e){ return d } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)) }catch(e){} },
  del(k){ try{ localStorage.removeItem(k) }catch(e){} }
};

/* Verified by hand on 26 Oct 2026. ads = every date the role was advertised. */
const SEED = [
  {title:'Sr UI/UX Designer', company:'Revpanda', url:'https://himalayas.app/companies/revpanda/jobs/sr-ui-ux-designer-6194227814', ads:['2026-10-25'], location:'Worldwide · open to all countries', type:'Full-time · Senior (3+ yrs)', track:['design'], elig:'yes', pay:null, note:'iGaming UI/UX. Figma, prototyping, A/B testing; "competitive salary", work from anywhere.', source:'Himalayas'},
  {title:'UI/UX Designer', company:'Zoftify', url:'https://himalayas.app/companies/zoftify-travel-software-development/jobs/ui-ux-designer', ads:['2026-10-24'], location:'Worldwide · 100% remote', type:'Full-time · Mid (2+ yrs)', track:['design'], elig:'yes', pay:null, note:'Travel-tech agency, mobile + web apps in Figma for clients in DE, CH, UK, US.', source:'Himalayas'},
  {title:'Lead Product Designer', company:'Zoftify', url:'https://himalayas.app/companies/zoftify-travel-software-development/jobs/lead-product-designer', ads:['2026-10-24'], location:'Worldwide · 100% remote', type:'Full-time · Senior (5+ yrs)', track:['design'], elig:'yes', pay:null, note:'Lead design on international projects, run client workshops, mentor designers.', source:'Himalayas'},
  {title:'Lead UX/UI Designer', company:'Prism Studio', url:'https://himalayas.app/companies/prism-studio/jobs/lead-ux-ui-designer-8750788806', ads:['2026-10-23'], location:'Worldwide, must work CET ±2h (Nigeria fits)', type:'Full-time · Senior (5+ yrs)', track:['design'], elig:'yes', pay:null, note:'Game UI for a PC/console shooter. Needs a shipped title and Unreal Engine UI experience.', source:'Himalayas'},
  {title:'Agentic UX Designer', company:'Agentplace', url:'https://himalayas.app/companies/agentplace/jobs/agentic-ux-designer', ads:['2026-10-23'], location:'Worldwide · open to all countries', type:'Contract · flexible hours', track:['design'], elig:'yes', pay:{min:2500,cur:'USD',period:'month',text:'From $2,500/month'}, note:'Design AI-agent builder UX and chat interfaces. Apply by emailing 3–5 UI improvements for agentplace.io.', source:'Himalayas'},
  {title:'AI Agent Builder (Vibe Coder)', company:'Agentplace', url:'https://himalayas.app/companies/agentplace/jobs/ai-agent-builder-vibe-coder', ads:['2026-10-23'], location:'Worldwide · open to all countries', type:'Contract · flexible hours', track:['claude','design'], elig:'yes', pay:{min:1500,cur:'USD',period:'month',text:'From $1,500/month'}, note:'UX + vibe coding to build AI agents for real businesses.', source:'Himalayas'},
  {title:'Product Designer & Builder (SmartyMe)', company:'Stellar Tech', url:'https://himalayas.app/companies/stellar-tech/jobs/product-designer-builder-for-smartyme', ads:['2026-08-12','2026-10-23'], location:'Worldwide · open to all countries', type:'Contract · Mid (3+ yrs)', track:['design','claude'], elig:'yes', pay:null, note:'Product designer who builds working prototypes in Claude Code/Codex for a 1M+ user learning app.', source:'Himalayas'},
  {title:'AI Engineer', company:'S-PRO', url:'https://himalayas.app/companies/s-pro/jobs/ai-engineer', ads:['2026-08-14','2026-10-26'], location:'Worldwide · open to all countries', type:'Full-time · Senior (4+ yrs)', track:['claude'], elig:'yes', pay:null, note:'Swiss software firm. Python, agentic frameworks, vector DBs; must be fluent with Claude Code or Codex.', source:'Himalayas'},
  {title:'Founding Engineer', company:'Shaper Capital', url:'https://himalayas.app/companies/shaper-capital/jobs/founding-engineer-shaper-capital', ads:['2026-08-11','2026-10-22'], location:'Worldwide · open to all countries', type:'Full-time · Senior', track:['claude'], elig:'yes', pay:null, note:'First engineer at a portfolio startup; AI-assisted development (Claude Code, Cursor). Cash + equity.', source:'Himalayas'},
  {title:'AI Engineer (Full-Stack)', company:'Hire Overseas', url:'https://ng.indeed.com/viewjob?jk=b4619cb16ac9c8a3', ads:['2026-10-21'], location:'Lagos, Nigeria · remote, paid in USD', type:'Full-time', track:['claude'], elig:'yes', pay:null, note:'Builds production AI systems with Claude Code as the primary tool.', source:'Indeed'},
  {title:'Senior Software Engineer (Codex / Claude Code)', company:'G2i', url:'https://himalayas.app/companies/g2i/jobs/senior-software-engineer-openai-codex-claude-code-or-cursor', ads:['2026-10-01'], location:'Worldwide', type:'Contract · 10–20 hrs/week', track:['claude'], elig:'yes', pay:{min:100,max:200,cur:'USD',period:'hour',text:'$100–$200/hour'}, note:'Evaluating AI coding agents.', source:'Himalayas'}
];

/* Startup boards: remote-first companies that often hire designers globally. Edit in Setup. */
const DEFAULT_BOARDS = [
  'jobs.ashbyhq.com/supabase', 'jobs.ashbyhq.com/posthog', 'jobs.ashbyhq.com/linear', 'jobs.ashbyhq.com/zapier',
  'jobs.ashbyhq.com/deel', 'jobs.ashbyhq.com/raycast', 'jobs.ashbyhq.com/replit',
  'boards.greenhouse.io/gitlab', 'boards.greenhouse.io/canonical', 'boards.greenhouse.io/remotecom',
  'boards.greenhouse.io/doist', 'boards.greenhouse.io/vercel', 'boards.greenhouse.io/mozilla'
];

/* ---------- state ---------- */
let state = ls.get(STORE_KEY, null);
if(!state || !state.jobs) state = {jobs:{}, meta:{}};
const M = state.meta;
M.saved ||= {}; M.applied ||= {}; M.sources ||= {}; M.boardStatus ||= {}; M.lastFetch ||= 0;
state.matches ||= {};
const save = () => ls.set(STORE_KEY, state);
const ui = {track:'all', q:'', payOnly:false, unclear:false, archive:false, sort: ls.get('jobradar.sort', 'new')};

/* ---------- helpers ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const decoder = document.createElement('textarea');
const decode = s => { decoder.innerHTML = String(s || ''); return decoder.value };
const strip = s => decode(String(s || '').replace(/<[^>]+>/g,' ')).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
const normKey = (co, t) => (String(co||'').toLowerCase().replace(/[^a-z0-9]/g,'') + '|' + String(t||'').toLowerCase().replace(/\([^)]*\)/g,'').replace(/\b(remote|100%|worldwide|anywhere|full[- ]?time|contract)\b/g,'').replace(/[^a-z0-9]/g,''));
const pad = n => String(n).padStart(2,'0');
const dayStr = d => d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
function toDate(v){
  if(v == null || v === '') return null;
  if(typeof v === 'number') return new Date(v < 1e12 ? v*1000 : v);
  let s = String(v).trim();
  if(/^\d+$/.test(s)) return toDate(+s);
  if(/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(' ','T');
  const d = new Date(s); return isNaN(d) ? null : d;
}
function ageDays(ds){
  const [y,m,d] = ds.split('-').map(Number);
  const then = new Date(y, m-1, d), now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today - then)/DAY));
}
const fmtDate = ds => { const [y,m,d] = ds.split('-').map(Number); return new Date(y,m-1,d).toLocaleDateString(undefined,{day:'numeric',month:'short'}) };

/* ---------- API to our own Vercel functions ---------- */
const pass = () => ls.get('jobradar.pass', '');
async function api(path, body, {raw=false, timeout=60000} = {}){
  if(!HOSTED) throw Object.assign(new Error('Open the live Vercel site to use Radar.'), {code:'offline'});
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  try{
    const r = await fetch('/api/' + path, {method:'POST', headers:{'content-type':'application/json','x-passcode':pass()}, body:JSON.stringify(body), signal:ctl.signal});
    if(!r.ok){
      const j = await r.json().catch(() => ({}));
      const e = new Error(j.error === 'bad_passcode' ? 'Wrong or missing passcode. Add it in Setup.' : j.error === 'not_configured' ? `Not set up yet: add ${j.missing} in Vercel (see Setup).` : (j.error || ('HTTP ' + r.status)));
      e.code = j.error; e.missing = j.missing; throw e;
    }
    return raw ? r : r.json();
  } finally { clearTimeout(t) }
}

/* ---------- pay ---------- */
const RATES = {USD:1,EUR:1.08,GBP:1.27,CAD:0.73,AUD:0.66,CHF:1.12,PLN:0.25,SEK:0.095,NOK:0.093,DKK:0.145,INR:0.012,BRL:0.18,MXN:0.055,ZAR:0.055,NGN:0.00065};
const PER = {year:1/12, month:1, week:4.33, day:21, hour:160};
function periodFrom(s){
  s = String(s||'').toLowerCase();
  if(/hour|hr|\/h\b/.test(s)) return 'hour';
  if(/month|\bmo\b|\/m\b/.test(s)) return 'month';
  if(/week|\bwk\b/.test(s)) return 'week';
  if(/\bday|daily/.test(s)) return 'day';
  if(/year|\byr\b|annual|\bpa\b|p\.a/.test(s)) return 'year';
  return null;
}
function parsePayText(s){
  if(!s || !/\d/.test(s)) return null;
  const low = String(s).toLowerCase();
  const cur = /€|eur/.test(low) ? 'EUR' : /£|gbp/.test(low) ? 'GBP' : /cad|ca\$/.test(low) ? 'CAD' : /aud|a\$/.test(low) ? 'AUD' : /chf/.test(low) ? 'CHF' : /pln|zł/.test(low) ? 'PLN' : /inr|₹/.test(low) ? 'INR' : 'USD';
  const nums = [...low.matchAll(/(\d[\d,]*\.?\d*)\s*(k)?/g)].map(m => parseFloat(m[1].replace(/,/g,'')) * (m[2] ? 1000 : 1)).filter(n => n > 0);
  if(!nums.length) return null;
  let period = periodFrom(low);
  const ref = nums[0];
  if(!period) period = ref >= 20000 ? 'year' : ref >= 1000 ? 'month' : ref < 300 ? 'hour' : null;
  if(!period) return null;
  return {min:nums[0], max:nums[1] || nums[0], cur, period, text:String(s).trim()};
}
function monthlyUSD(p){
  if(!p) return null;
  const rate = RATES[(p.cur||'USD').toUpperCase()], f = PER[p.period];
  const v = p.min || p.max;
  if(!rate || !f || !v) return null;
  return Math.round(v * rate * f);
}

/* ---------- classification ---------- */
function classify(j){
  const title = (j.title||'').toLowerCase(), all = title + ' ' + (j.text||'').toLowerCase();
  const tracks = [];
  const designTitle = /\bui\b|\bux\b|ui\/ux|ux\/ui|product design|user experience|user interface|interaction design|design system|figma|design engineer/.test(title);
  const notDesign = /graphic|instructional|interior|packaging|apparel|fashion|landscape|mechanical|electrical|civil|kitchen|floral|copywriter|hardware|chip|circuit/.test(title);
  if(designTitle && !notDesign) tracks.push('design');
  if(/claude/.test(all)) tracks.push('claude');
  return tracks;
}
const NO_REGION = /usa|united states|\bus\b|u\.s\.|canada|\buk\b|united kingdom|europe\b|\beu\b|latam|latin america|apac|asia|india|brazil|mexico|germany|poland|philippines|australia|spain|france|portugal|ukraine|argentina|americas|north america|cet\b only|on-?site|hybrid/;
function eligibility(j){
  if(Array.isArray(j.restrictions)){
    if(j.restrictions.length === 0) return 'yes';
    const n = j.restrictions.map(x => typeof x === 'string' ? x : (x && (x.name || x.alpha2 || x.code)) || '').join(' ').toLowerCase();
    return /nigeria|\bng\b|africa|emea/.test(n) ? 'yes' : 'no';
  }
  const t = (j.location||'').toLowerCase().trim();
  if(!t) return 'unclear';
  if(/nigeria|africa|emea|worldwide|anywhere|global|all countries|international|work from anywhere/.test(t)) return 'yes';
  if(NO_REGION.test(t)) return 'no';
  return 'unclear';
}

/* ---------- ingest ---------- */
function ingest(j, isSeed){
  const key = normKey(j.company, j.title);
  if(!key || key === '|') return;
  const ads = (j.ads || [(() => { const d = toDate(j.posted); return d ? dayStr(d) : null })()]).filter(Boolean);
  if(!ads.length) return;
  const cur = state.jobs[key];
  if(!cur){
    state.jobs[key] = {key, title:j.title, company:j.company, url:j.url, location:j.location||'', type:j.type||'', track:j.track, elig:j.elig, pay:j.pay||null, note:j.note||'', snip:j.snip||'', ads:[...new Set(ads)].sort(), sources:[j.source], seed:!!isSeed};
    return;
  }
  ads.forEach(a => { if(!cur.ads.includes(a)) cur.ads.push(a) });
  cur.ads.sort();
  if(j.source && !cur.sources.includes(j.source)) cur.sources.push(j.source);
  if(!cur.pay && j.pay) cur.pay = j.pay;
  if(!cur.snip && j.snip) cur.snip = j.snip;
  if((!cur.location || cur.elig !== 'yes') && j.elig === 'yes'){ cur.location = j.location; cur.elig = 'yes' }
  if(isSeed){ Object.assign(cur, {url:j.url, note:j.note, type:j.type, track:j.track, seed:true}) }
  else if(j.url && !cur.seed) cur.url = j.url;
}
function prepLive(raw){
  const out = [];
  for(const j of raw){
    if(!j || !j.title || !j.company) continue;
    j.title = strip(j.title); j.company = strip(j.company);
    const track = classify(j); if(!track.length) continue;
    const pay = j.pay || parsePayText(j.payText);
    const elig = j.elig || eligibility(j);
    if(elig === 'no') continue;
    out.push({title:j.title, company:j.company, url:j.url, posted:j.posted, location:j.location || (Array.isArray(j.restrictions) && !j.restrictions.length ? 'Worldwide' : ''), type:j.type||'', track, elig, pay, snip:String(j.text||'').slice(0,900), source:j.source});
  }
  return out;
}

/* ---------- fetching ---------- */
async function fetchRaw(url, asText){
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000);
  try{ const r = await fetch(url, {signal:ctl.signal}); if(!r.ok) throw new Error('HTTP '+r.status); return asText ? await r.text() : await r.json() }
  finally{ clearTimeout(t) }
}
/* On Vercel, feeds go through /api/proxy (no browser blocking, cached 6h). Opened as a file, they're fetched directly. */
async function getJSON(url){
  if(HOSTED){ try{ return await fetchRaw('/api/proxy?url=' + encodeURIComponent(url)) }catch(e){} }
  return fetchRaw(url);
}
async function getText(url){
  if(HOSTED){ try{ return await fetchRaw('/api/proxy?url=' + encodeURIComponent(url), true) }catch(e){} }
  return fetchRaw(url, true);
}
async function multi(urls, fn, getter = getJSON){
  const res = await Promise.allSettled(urls.map(getter));
  const ok = res.filter(r => r.status === 'fulfilled');
  if(!ok.length) throw (res[0].reason || new Error('failed'));
  return ok.flatMap(r => fn(r.value));
}
const xmlText = (el, tag) => { const n = el.getElementsByTagName(tag)[0]; return n ? n.textContent : '' };

/* startup boards: parse a careers link into {ats, slug} */
function parseBoard(line){
  const s = String(line||'').trim().replace(/^https?:\/\//,'').replace(/\/+$/,'');
  if(!s) return null;
  let m;
  if((m = s.match(/^(?:jobs\.)?ashbyhq\.com\/([^/?#]+)/i))) return {ats:'ashby', slug:m[1]};
  if((m = s.match(/^(?:job-)?boards(?:-api)?\.greenhouse\.io\/(?:v1\/boards\/)?([^/?#]+)/i))) return {ats:'greenhouse', slug:m[1]};
  if((m = s.match(/^(?:jobs|api)\.lever\.co\/(?:v0\/postings\/)?([^/?#]+)/i))) return {ats:'lever', slug:m[1]};
  if((m = s.match(/^(ashby|greenhouse|lever)\s*[:/]\s*([\w.-]+)$/i))) return {ats:m[1].toLowerCase(), slug:m[2]};
  return null;
}
const boardList = () => ls.get('jobradar.boards', DEFAULT_BOARDS);
const niceName = slug => slug.replace(/[-_.]+/g,' ').replace(/\b(com|inc|hq|careers|jobs)\b/gi,'').trim().replace(/\b\w/g, c => c.toUpperCase()) || slug;
function remoteOk(loc, isRemote){ return isRemote || /remote|anywhere|worldwide|distributed/i.test(loc || '') }

async function fetchBoard(b){
  const name = niceName(b.slug);
  if(b.ats === 'ashby'){
    const d = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(b.slug)}?includeCompensation=true`);
    return (d.jobs||[]).filter(j => remoteOk(j.location, j.isRemote || j.workplaceType === 'Remote')).map(j => {
      const locs = [j.location].concat((j.secondaryLocations||[]).map(x => x.location || x)).filter(Boolean).join(' · ');
      return {title:j.title, company:name, url:j.jobUrl || j.applyUrl, posted:j.publishedAt, location: locs + (j.isRemote && !/remote/i.test(locs) ? ' · Remote' : ''), type:j.employmentType || '',
        payText: j.compensation && (j.compensation.compensationTierSummary || j.compensation.scrapeableCompensationSalarySummary) || '', text:(j.descriptionPlain || strip(j.descriptionHtml)).slice(0,5000), source:'Startup boards'};
    });
  }
  if(b.ats === 'greenhouse'){
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(b.slug)}/jobs?content=true`);
    return (d.jobs||[]).filter(j => remoteOk(j.location && j.location.name)).map(j => ({title:j.title, company:(j.company_name || name), url:j.absolute_url, posted:j.first_published || j.updated_at, location:(j.location && j.location.name) || '', type:'', text:strip(j.content).slice(0,5000), source:'Startup boards'}));
  }
  if(b.ats === 'lever'){
    const d = await getJSON(`https://api.lever.co/v0/postings/${encodeURIComponent(b.slug)}?mode=json`);
    return (Array.isArray(d)?d:[]).filter(j => remoteOk(j.categories && j.categories.location, j.workplaceType === 'remote')).map(j => ({title:j.text, company:name, url:j.hostedUrl, posted:j.createdAt, location:[(j.categories||{}).location, j.workplaceType === 'remote' ? 'Remote' : ''].filter(Boolean).join(' · '), type:(j.categories||{}).commitment || '',
      pay: j.salaryRange && j.salaryRange.min ? {min:j.salaryRange.min, max:j.salaryRange.max, cur:j.salaryRange.currency || 'USD', period: periodFrom(j.salaryRange.interval) || 'year', text:''} : null,
      text:(j.descriptionPlain || '').slice(0,5000), source:'Startup boards'}));
  }
  return [];
}

/* HN "Who is hiring": first line of each comment is usually "Company | Role | Location | ..." */
function hnParse(c){
  const html = String(c.comment_text || '');
  const first = strip(html.split(/<p>/i)[0]);
  const all = strip(html);
  const parts = first.split(/\s*\|\s*/).filter(Boolean);
  const company = (parts[0] || '').slice(0, 80);
  const roleRx = /design|ux|ui\b|product|claude|engineer|developer/i;
  const role = parts.slice(1).find(p => roleRx.test(p)) || parts[1] || first;
  const loc = parts.find(p => /remote|onsite|on-site|hybrid|worldwide|anywhere|global/i.test(p)) || '';
  const titleForClass = /design|ux|ui\b/i.test(first) ? role + ' (design)' : role;
  const elig = /worldwide|anywhere|global|africa|emea|nigeria/i.test(loc + ' ' + all.slice(0,600)) ? 'yes' : (/remote/i.test(loc) && !NO_REGION.test(loc.toLowerCase())) ? 'unclear' : 'no';
  return {title: titleForClass.replace(' (design)','').slice(0,140), _classTitle:titleForClass, company, url:'https://news.ycombinator.com/item?id=' + c.objectID, posted:c.created_at, location: loc || 'See post', elig, text:all.slice(0,5000), source:'HN Who\'s hiring'};
}
async function fetchHN(){
  const s = await getJSON('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=6');
  const story = (s.hits||[]).find(h => /who is hiring/i.test(h.title || ''));
  if(!story) return [];
  const id = story.objectID;
  const qs = ['designer', 'ux', 'claude'].map(q => `https://hn.algolia.com/api/v1/search?tags=comment,story_${id}&hitsPerPage=200&query=${q}`);
  const res = await multi(qs, d => d.hits || []);
  const seen = new Set();
  return res.filter(c => String(c.parent_id) === String(id) && !seen.has(c.objectID) && seen.add(c.objectID)).map(hnParse)
    .map(j => { const t = classify({title:j._classTitle, text:j.text}); return t.length ? j : null }).filter(Boolean);
}

const SOURCES = {
  'Remotive': () => multi([
      'https://remotive.com/api/remote-jobs?category=design',
      'https://remotive.com/api/remote-jobs?search=claude'
    ], d => (d.jobs||[]).map(j => ({title:j.title, company:j.company_name, url:j.url, posted:j.publication_date, location:j.candidate_required_location, payText:j.salary, type:(j.job_type||'').replace(/_/g,' '), text:(j.tags||[]).join(' ')+' '+strip(j.description).slice(0,5000), source:'Remotive'}))),
  'Jobicy': () => multi([
      'https://jobicy.com/api/v2/remote-jobs?count=50&tag=ui%20ux',
      'https://jobicy.com/api/v2/remote-jobs?count=50&tag=product%20designer',
      'https://jobicy.com/api/v2/remote-jobs?count=50&tag=claude'
    ], d => (d.jobs||[]).map(j => {
      const min = +(j.salaryMin ?? j.annualSalaryMin ?? 0), max = +(j.salaryMax ?? j.annualSalaryMax ?? 0);
      return {title:j.jobTitle, company:j.companyName, url:j.url, posted:j.pubDate, location:j.jobGeo, type:[].concat(j.jobType||[]).join(', '),
        pay: (min||max) ? {min, max, cur:j.salaryCurrency||'USD', period: periodFrom(j.salaryPeriod) || (j.annualSalaryMin ? 'year' : (min >= 20000 ? 'year' : 'month')), text:''} : null,
        text:(j.jobExcerpt||'')+' '+strip(j.jobDescription).slice(0,5000), source:'Jobicy'};
    })),
  'Remote OK': () => multi(['https://remoteok.com/api'], d => (Array.isArray(d)?d:[]).filter(j => j && j.position).map(j => ({title:j.position, company:j.company, url:j.url || j.apply_url, posted:j.date || j.epoch, location:j.location, pay: j.salary_min ? {min:j.salary_min, max:j.salary_max, cur:'USD', period:'year', text:''} : null, text:(j.tags||[]).join(' ')+' '+strip(j.description).slice(0,5000), source:'Remote OK'}))),
  'Himalayas': () => multi(
      ['ui ux designer','product designer','claude code'].map(q => 'https://himalayas.app/jobs/api/search?q='+encodeURIComponent(q)+'&sort=recent'),
      d => (d.jobs||[]).map(j => ({title:j.title, company:j.companyName, url:j.applicationLink || j.guid, posted:j.pubDate, restrictions: j.locationRestrictions || [], type:j.employmentType || '',
        pay: j.minSalary ? {min:j.minSalary, max:j.maxSalary, cur:j.currency || 'USD', period: periodFrom(j.salaryPeriod) || 'year', text:''} : null,
        text:[].concat(j.categories||[]).join(' ')+' '+(j.excerpt||'')+' '+strip(j.description).slice(0,5000), source:'Himalayas'}))),
  'We Work Remotely': () => multi([
      'https://weworkremotely.com/categories/remote-design-jobs.rss',
      'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
      'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss'
    ], xml => {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      return [...doc.getElementsByTagName('item')].map(it => {
        const t = xmlText(it,'title'), i = t.indexOf(':');
        return {title: i > 0 ? t.slice(i+1).trim() : t, company: i > 0 ? t.slice(0,i).trim() : 'Unknown', url:xmlText(it,'link'), posted:xmlText(it,'pubDate'), location:xmlText(it,'region') || xmlText(it,'country'), type:xmlText(it,'type'), text:strip(xmlText(it,'description')).slice(0,5000), source:'We Work Remotely'};
      });
    }, getText),
  'Working Nomads': () => multi(['https://www.workingnomads.com/api/exposed_jobs/'], d => (Array.isArray(d)?d:[]).map(j => ({title:j.title, company:j.company_name, url:j.url, posted:j.pub_date, location:j.location, type:j.category_name || '', text:[j.tags, strip(j.description)].join(' ').slice(0,5000), source:'Working Nomads'}))),
  'HN Who\'s hiring': fetchHN,
  'Startup boards': async () => {
    const boards = boardList().map(parseBoard).filter(Boolean);
    const res = await Promise.allSettled(boards.map(fetchBoard));
    const status = {};
    res.forEach((r, i) => { status[boards[i].ats + ':' + boards[i].slug] = r.status === 'fulfilled' ? r.value.length : -1 });
    M.boardStatus = status;
    const ok = res.filter(r => r.status === 'fulfilled');
    if(!ok.length && boards.length) throw new Error('No boards reachable');
    return ok.flatMap(r => r.value);
  }
};

let fetching = false;
async function refresh(){
  if(fetching) return; fetching = true;
  const btn = document.getElementById('refresh');
  btn.disabled = true; btn.classList.add('loading'); document.getElementById('refreshLabel').textContent = 'Fetching…';
  const names = Object.keys(SOURCES);
  await Promise.allSettled(names.map(async n => {
    try{
      const jobs = prepLive(await SOURCES[n]());
      jobs.forEach(j => ingest(j, false));
      M.sources[n] = {ok:true, count:jobs.length, at:Date.now()};
    }catch(e){
      M.sources[n] = {ok:false, err:String(e && e.message || e || 'unavailable'), at:Date.now()};
    }
    render();
  }));
  M.lastFetch = Date.now();
  save(); render(); renderBoardStatus();
  btn.disabled = false; btn.classList.remove('loading'); document.getElementById('refreshLabel').textContent = 'Fetch latest';
  fetching = false;
  autoScore();
}

/* ---------- match scores ---------- */
const profile = () => ls.get('jobradar.profile', null);
const pv = () => ls.get('jobradar.pv', 0);
const matchOf = j => { const m = state.matches[j.key]; return m && m.pv === pv() ? m : null };
let scoring = null;
function scoreTargets(){
  return Object.values(state.jobs).map(enrich).filter(j => j.live && j.payState !== 'low' && j.elig !== 'no' && !matchOf(j));
}
async function scoreMatches(){
  const p = profile(); if(!p || scoring) return;
  const todo = scoreTargets();
  if(!todo.length){ render(); return }
  scoring = {done:0, total:todo.length, err:''}; render();
  for(let i = 0; i < todo.length; i += 20){
    const batch = todo.slice(i, i+20);
    try{
      const {results} = await api('match', {profile:p, jobs: batch.map(j => ({id:j.key, title:j.title, company:j.company, location:j.location, type:j.type, pay: j.monthly ? `~$${j.monthly}/month` : (j.pay && j.pay.text) || 'not stated', snippet:[j.note, j.snip].filter(Boolean).join(' ')}))});
      results.forEach(r => { state.matches[r.id] = {score:r.score, why:r.why, gaps:r.gaps, pv:pv()} });
      save();
    }catch(e){ scoring.err = e.message; break }
    scoring.done = Math.min(todo.length, i + batch.length); render();
  }
  const err = scoring.err; scoring = null;
  if(err) scoringError = err;
  render();
}
let scoringError = '';
function autoScore(){ if(profile() && HOSTED && pass()) scoreMatches() }

/* ---------- view ---------- */
function enrich(j){
  const last = j.ads[j.ads.length-1], first = j.ads[0];
  const age = ageDays(last);
  const monthly = monthlyUSD(j.pay);
  return {...j, last, first, age, live: age <= WINDOW, re: j.ads.length > 1, monthly, match: matchOf(j),
    payState: monthly == null ? 'unknown' : monthly >= MIN_MONTHLY ? 'ok' : 'low'};
}
function passes(j){
  if(j.payState === 'low' || j.elig === 'no') return false;
  if(j.elig === 'unclear' && !ui.unclear) return false;
  if(ui.payOnly && j.payState !== 'ok') return false;
  if(ui.track === 'saved' && !M.saved[j.key]) return false;
  if(ui.track === 'top' && !(j.match && j.match.score >= 70)) return false;
  if(ui.track === 'design' && !(j.track||[]).includes('design')) return false;
  if(ui.track === 'claude' && !(j.track||[]).includes('claude')) return false;
  if(ui.q){ const hay = [j.title,j.company,j.note,j.location,j.type,(j.track||[]).join(' '),j.match && j.match.why].join(' ').toLowerCase(); if(!ui.q.split(/\s+/).every(w => hay.includes(w))) return false }
  return true;
}
function card(j){
  const left = WINDOW - j.age;
  const pct = Math.max(0, Math.min(100, left / WINDOW * 100));
  const barCls = left <= 0 ? 'end' : left <= 3 ? 'warn' : '';
  const ageTxt = j.age === 0 ? 'Today' : j.age === 1 ? '1 day ago' : j.age + ' days ago';
  const payPill = j.payState === 'ok' ? `<span class="pill pay">≈ $${j.monthly.toLocaleString()}/mo${j.pay.period==='hour'?' FT':''}</span>` : `<span class="pill nopay">Pay not listed</span>`;
  const tracks = (j.track||[]).map(t => `<span class="pill ${t}">${t==='design'?'UI/UX':'Claude Code'}</span>`).join('');
  const reTxt = j.re ? `<span class="pill re" title="First advertised ${fmtDate(j.first)}">Re-advertised</span>` : '';
  const newTxt = j.age <= 1 && j.live ? `<span class="pill new">New</span>` : '';
  const fresh = j.live
    ? `<div class="fresh"><div class="bar"><i class="${barCls}" style="width:${pct}%"></i></div>${left === 0 ? 'Leaves board tomorrow' : 'Leaves board in ' + left + (left===1?' day':' days')}</div>`
    : `<div class="fresh">Removed. Last advertised ${fmtDate(j.last)} (${j.age} days ago)</div>`;
  const payLine = j.pay && j.pay.text ? esc(j.pay.text) : j.pay ? `${esc(j.pay.cur)} ${Number(j.pay.min).toLocaleString()}${j.pay.max && j.pay.max!==j.pay.min ? '–'+Number(j.pay.max).toLocaleString():''} / ${esc(j.pay.period)}` : 'Not stated';
  const m = j.match;
  const matchBox = m ? `<div class="match"><div class="score" style="--v:${m.score}"><span>${m.score}</span></div><div><p>${esc(m.why)}</p>${m.gaps ? `<p class="gap">Gap: ${esc(m.gaps)}</p>` : ''}</div></div>` : '';
  const blurb = j.note || (j.snip ? j.snip.slice(0, 170) + (j.snip.length > 170 ? '…' : '') : '');
  return `<article class="card${j.live?'':' archived'}">
    <div class="row">${tracks}${newTxt}${reTxt}<span class="age">${ageTxt}</span></div>
    <div><h3>${esc(j.title)}</h3><div class="co">${esc(j.company)}</div></div>
    ${matchBox}
    <div class="row">${payPill}${j.elig==='unclear'?'<span class="pill">Check location</span>':''}${j.seed?'<span class="pill" title="Checked by hand">Verified pick</span>':''}</div>
    <dl class="meta">
      <dt>Where</dt><dd>${esc(j.location || 'Not stated')}</dd>
      ${j.type?`<dt>Type</dt><dd>${esc(j.type)}</dd>`:''}
      <dt>Pay</dt><dd>${payLine}</dd>
      <dt>Posted</dt><dd>${j.ads.map(fmtDate).join(' → ')} · via ${esc((j.sources||[]).join(', '))}</dd>
    </dl>
    ${blurb?`<p class="note">${esc(blurb)}</p>`:''}
    ${fresh}
    <div class="actions">
      <a href="${esc(j.url)}" target="_blank" rel="noopener">View &amp; apply ↗</a>
      <button class="ic" data-save="${esc(j.key)}" aria-pressed="${!!M.saved[j.key]}" title="Save" aria-label="Save job">${M.saved[j.key]?'★':'☆'}</button>
      <button class="ic" data-applied="${esc(j.key)}" aria-pressed="${!!M.applied[j.key]}">${M.applied[j.key]?'Applied ✓':'Applied?'}</button>
    </div>
  </article>`;
}
function banner(){
  const el = document.getElementById('matchBanner');
  const p = profile();
  if(!p){
    el.innerHTML = `<div><b>Get every job scored for you</b><p>Have a 10-minute conversation with Radar and it ranks this board by how well each role fits you.</p></div><a class="btn" href="#radar">Meet Radar</a>`;
    return;
  }
  if(scoring){ el.innerHTML = `<div><b>Scoring matches… ${scoring.done}/${scoring.total}</b><p>Radar is reading each role against your profile.</p></div>`; return }
  const left = scoreTargets().length;
  const err = scoringError ? `<p style="color:#FFB4A2">${esc(scoringError)}</p>` : '';
  el.innerHTML = `<div><b>${esc(p.headline || 'Your profile is ready')}</b><p>${left ? left + ' jobs not scored yet.' : 'Every live job is scored. Sort by "Best match" or open "Top matches".'}</p>${err}</div>
    <div class="row">${left ? '<button class="btn" id="scoreBtn">Score matches</button>' : ''}<a class="btn" href="#radar" style="background:transparent;color:inherit;border-color:rgba(255,255,255,.25)">Edit profile</a></div>`;
  const b = document.getElementById('scoreBtn'); if(b) b.onclick = () => { scoringError = ''; if(!pass()){ location.hash = '#setup'; return } scoreMatches() };
}
function render(){
  const all = Object.values(state.jobs).map(enrich).filter(j => j.payState !== 'low' && j.elig !== 'no');
  const liveAll = all.filter(j => j.live && (j.elig === 'yes' || ui.unclear));
  const shown = all.filter(passes);
  const byNew = (a,b) => b.last.localeCompare(a.last) || (b.payState==='ok') - (a.payState==='ok');
  const byMatch = (a,b) => ((b.match ? b.match.score : -1) - (a.match ? a.match.score : -1)) || byNew(a,b);
  const live = shown.filter(j => j.live).sort(ui.sort === 'match' ? byMatch : byNew);
  const gone = shown.filter(j => !j.live).sort(byNew);
  banner();
  document.getElementById('stats').innerHTML = [
    [liveAll.length, 'Live on the board'],
    [liveAll.filter(j => j.age <= 1).length, 'New in the last 24h'],
    [profile() ? liveAll.filter(j => j.match && j.match.score >= 70).length : liveAll.filter(j => j.payState === 'ok').length, profile() ? 'Strong matches (70+)' : 'Pay confirmed $1k+'],
    [all.filter(j => !j.live).length, 'Removed (> 10 days)']
  ].map(([n,l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');
  const src = M.sources, names = Object.keys(SOURCES);
  const last = M.lastFetch ? new Date(M.lastFetch).toLocaleString(undefined,{weekday:'short',hour:'2-digit',minute:'2-digit'}) : 'never';
  document.getElementById('sources').innerHTML = `<span>Last fetched: <i>${esc(last)}</i></span>` + names.map(n => {
    const s = src[n]; if(!s) return `<span>${esc(n)}: <i>${fetching ? 'fetching…' : 'not fetched'}</i></span>`;
    return s.ok ? `<span>${esc(n)}: <i class="ok">✓ ${s.count}</i></span>` : `<span title="${esc(s.err)}">${esc(n)}: <i class="bad">✕ unavailable</i></span>`;
  }).join('');
  const emptyTxt = ui.track === 'top' && !profile() ? 'Meet Radar first, then your top matches show here.' : 'Nothing matches right now. Try another tab, clear the search, or fetch the latest.';
  document.getElementById('live').innerHTML = live.length
    ? `<div class="section-title">On the board · ${live.length}</div><div class="grid">${live.map(card).join('')}</div>`
    : `<div class="empty">${emptyTxt}</div>`;
  document.getElementById('archive').innerHTML = ui.archive && gone.length
    ? `<div class="section-title">Removed: not advertised in the last ${WINDOW} days · ${gone.length}</div><div class="grid">${gone.map(card).join('')}</div>` : '';
}

/* ---------- setup view ---------- */
async function renderHealth(){
  const el = document.getElementById('health');
  if(!HOSTED){ el.innerHTML = '<li>⚠️ You opened this as a file. Radar\'s AI and voice only work on the live Vercel site.</li>'; return }
  let h = {};
  try{ h = await (await fetch('/api/health', {cache:'no-store'})).json() }catch(e){ el.innerHTML = '<li>⚠️ Couldn\'t reach the site\'s API.</li>'; return }
  const li = (ok, txt) => `<li>${ok ? '✅' : '⬜'} ${txt}</li>`;
  el.innerHTML = li(h.passcode, '<code>APP_PASSCODE</code> set') + li(h.claude, '<code>ANTHROPIC_API_KEY</code> set (interview + match scores)') + li(h.voice, '<code>ELEVENLABS_API_KEY</code> set (voice)') + li(!!pass(), 'Passcode saved in this browser');
  JR.health = h;
}
function renderBoardStatus(){
  const el = document.getElementById('boardStatus'); if(!el) return;
  const st = M.boardStatus || {};
  el.innerHTML = boardList().map(parseBoard).filter(Boolean).map(b => {
    const v = st[b.ats + ':' + b.slug];
    return `<span>${esc(niceName(b.slug))} <i style="font-style:normal" class="${v == null ? '' : v < 0 ? 'bad' : 'ok'}">${v == null ? '·' : v < 0 ? '✕ not found' : '✓ ' + v + ' remote'}</i></span>`;
  }).join('');
}
function initSetup(){
  const passEl = document.getElementById('pass'), msg = document.getElementById('setupMsg');
  passEl.value = pass();
  document.getElementById('savePass').onclick = () => { ls.set('jobradar.pass', passEl.value.trim()); msg.innerHTML = '<p class="msg info">Passcode saved.</p>'; renderHealth() };
  const ta = document.getElementById('boards');
  ta.value = boardList().join('\n');
  document.getElementById('saveBoards').onclick = () => {
    const lines = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
    const bad = lines.filter(l => !parseBoard(l));
    ls.set('jobradar.boards', lines.filter(parseBoard));
    msg.innerHTML = bad.length ? `<p class="msg err">Skipped ${bad.length} line(s) that aren't Ashby/Greenhouse/Lever links.</p>` : '';
    renderBoardStatus(); refresh();
  };
  document.getElementById('resetBoards').onclick = () => { ls.del('jobradar.boards'); ta.value = DEFAULT_BOARDS.join('\n'); renderBoardStatus() };
  document.getElementById('wipe').onclick = () => {
    if(!confirm('Clear saved jobs, applied marks, your profile and interview from this browser?')) return;
    ['jobradar.v1','jobradar.profile','jobradar.pv','jobradar.radar','jobradar.boards','jobradar.sort'].forEach(ls.del);
    location.reload();
  };
  renderBoardStatus();
}

/* ---------- routing ---------- */
function route(){
  const v = (location.hash || '#board').slice(1);
  const view = ['board','radar','setup'].includes(v) ? v : 'board';
  ['board','radar','setup'].forEach(x => document.getElementById('view-' + x).hidden = x !== view);
  document.querySelectorAll('.nav a').forEach(a => a.setAttribute('aria-current', a.dataset.view === view ? 'page' : 'false'));
  if(view === 'setup') renderHealth();
  if(view === 'board') render();
  if(window.Radar && view === 'radar') window.Radar.show();
  window.scrollTo(0, 0);
}

/* ---------- events ---------- */
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-pressed', x === b));
  ui.track = b.dataset.track; if(ui.track === 'top') { ui.sort = 'match'; document.getElementById('sort').value = 'match' } render();
}));
document.getElementById('q').addEventListener('input', e => { ui.q = e.target.value.trim().toLowerCase(); render() });
const sortEl = document.getElementById('sort'); sortEl.value = ui.sort;
sortEl.addEventListener('change', () => { ui.sort = sortEl.value; ls.set('jobradar.sort', ui.sort); render() });
[['tPay','payOnly'],['tUnclear','unclear'],['tArchive','archive']].forEach(([id,k]) => {
  const el = document.getElementById(id);
  el.addEventListener('click', () => { ui[k] = !ui[k]; el.setAttribute('aria-pressed', ui[k]); render() });
});
document.addEventListener('click', e => {
  const s = e.target.closest('[data-save]'), a = e.target.closest('[data-applied]');
  if(s){ const k = s.dataset.save; M.saved[k] ? delete M.saved[k] : M.saved[k] = 1; save(); render() }
  if(a){ const k = a.dataset.applied; M.applied[k] ? delete M.applied[k] : M.applied[k] = 1; save(); render() }
});
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('theme').addEventListener('click', () => {
  const r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  r.dataset.theme = dark ? 'light' : 'dark'; ls.set('jobradar.theme', r.dataset.theme);
});
{ const t = ls.get('jobradar.theme', null); if(t) document.documentElement.dataset.theme = t }
window.addEventListener('hashchange', route);

/* expose for radar.js */
const JR = window.JR = {api, ls, esc, HOSTED, health:null, pass,
  setProfile(p){ ls.set('jobradar.profile', p); ls.set('jobradar.pv', pv() + 1); render() },
  scoreMatches(){ scoringError = ''; return scoreMatches() }, profile};

/* ---------- boot ---------- */
SEED.forEach(j => ingest(j, true));
save(); initSetup(); route();
if(HOSTED) fetch('/api/health', {cache:'no-store'}).then(r => r.json()).then(h => { JR.health = h }).catch(() => {});
if(Date.now() - (M.lastFetch || 0) > AUTO_MS) refresh(); else autoScore();
setInterval(() => { render(); if(Date.now() - M.lastFetch > AUTO_MS) refresh() }, 30*60e3);
})();
