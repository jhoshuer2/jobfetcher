// Scores a batch of jobs against the candidate's profile.
// Body: { profile, jobs: [{id,title,company,location,type,pay,snippet}] }  →  { results: [{id, score, why, gaps}] }
const { checkAuth, requireEnv, readJson, claude, extractJson, MODELS } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!checkAuth(req, res) || !requireEnv(res, 'ANTHROPIC_API_KEY')) return;

  let body;
  try { body = await readJson(req); } catch { return res.status(400).json({ error: 'Bad JSON' }); }
  const jobs = (Array.isArray(body.jobs) ? body.jobs : []).slice(0, 25).map(j => ({
    id: String(j.id || '').slice(0, 200), title: String(j.title || '').slice(0, 200), company: String(j.company || '').slice(0, 120),
    location: String(j.location || '').slice(0, 160), type: String(j.type || '').slice(0, 80), pay: String(j.pay || '').slice(0, 80),
    snippet: String(j.snippet || '').slice(0, 900)
  }));
  if (!jobs.length) return res.status(200).json({ results: [] });
  const profile = JSON.stringify(body.profile || {}).slice(0, 6000);

  try {
    const text = await claude({
      model: MODELS.match(),
      system: `You are a strict, honest recruiter. Score how well each job fits the candidate (0-100).
90+: near-perfect fit on role, seniority, skills and work type. 70-89: strong fit with small gaps. 50-69: plausible stretch. <50: poor fit.
Penalise: seniority mismatch, core skills they lack, pay below their minimum, location rules that exclude Nigeria, work types they ruled out, dealbreakers.
"why": max 18 words, specific (name the matching skill/project). "gaps": max 14 words, what they'd need to address, or "" if none.`,
      messages: [{ role: 'user', content: `Candidate profile:\n${profile}\n\nJobs:\n${JSON.stringify(jobs)}\n\nReturn ONLY a JSON array: [{"id":"...","score":0,"why":"...","gaps":"..."}] with one entry per job, same ids.` }],
      maxTokens: 2500
    });
    const arr = extractJson(text);
    if (!Array.isArray(arr)) return res.status(502).json({ error: 'Could not read scores' });
    const ids = new Set(jobs.map(j => j.id));
    const results = arr.filter(r => r && ids.has(String(r.id))).map(r => ({
      id: String(r.id), score: Math.max(0, Math.min(100, Math.round(+r.score || 0))),
      why: String(r.why || '').slice(0, 200), gaps: String(r.gaps || '').slice(0, 160)
    }));
    return res.status(200).json({ results });
  } catch (e) {
    return res.status(502).json({ error: 'AI request failed: ' + e.message });
  }
};
