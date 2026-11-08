// The "Meet Radar" interviewer. Three modes:
//   brief     – read a CV (PDF or text) + pasted notes, return {name, brief}
//   interview – next interviewer turn, given the brief and the conversation so far
//   profile   – turn the brief + conversation into a structured profile JSON
const { requireUser, requireEnv, readJson, claude, extractJson, MODELS, quotaOr429, db } = require('./_lib');

const PROFILE_SHAPE = `{
  "name": "", "headline": "one line, e.g. 'Product designer & AI builder'",
  "summary": "3-4 sentences in second person about who they are and what they're great at",
  "roles": ["2-5 job titles they want AND fit, e.g. 'Product Designer'"],
  "skills": [""], "tools": [""],
  "seniority": "junior | mid | senior | lead",
  "years": 0,
  "workTypes": ["full-time","contract","freelance","fractional","advisory","expert calls"],
  "minMonthlyUSD": 1000,
  "country": "country they live in", "timezone": "",
  "email": "contact email if stated", "phone": "", "portfolio": ["links they gave"],
  "hours": "availability / time-zone notes",
  "strengths": ["evidence-backed strengths, each with the proof"],
  "interests": ["domains/problems they want to work on"],
  "dealbreakers": [""],
  "keywords": ["search words to find matching jobs"]
}`;

const INTERVIEWER = (brief, name) => `You are Radar, a warm, sharp career interviewer (in the spirit of an expert-network voice agent). You are speaking out loud with ${name || 'the candidate'}, a professional looking for remote work. Don't assume their field, country or pay: learn them.

What you already know from their CV and notes:
"""
${brief || '(nothing yet — learn it from the conversation)'}
"""

Your job: in about 8–12 questions, understand them deeply enough to match them to full-time roles, contracts, fractional work, advisory, expert calls and research projects.
Cover, in a natural order: the story behind their best work; one or two projects in depth (their exact role, decisions, trade-offs, results); their core skills and tools; seniority and team experience; the exact roles they want next; the kinds of work they're open to (full-time, contract, fractional, advisory); minimum monthly pay in USD; which country they live in and their time zone; dealbreakers.

Style rules — this is SPOKEN aloud:
- Reply in at most 2 short sentences: one brief, specific reflection on what they just said (no generic praise), then ONE question.
- Never ask two questions at once. No lists, no markdown, no emojis.
- Use what you already know so you don't ask for things the CV answers; dig for depth instead.
- If an answer is vague, ask for a concrete example or number.
- If they say they can't hear you or ask something off-topic, answer briefly and return to the interview.
- Never invent facts about them.
- On your very first turn, greet them by name, say in one sentence what you'll do ("a short conversation so I can match you to work worth your time; it stays private"), then ask your first question, grounded in their CV.
- When you have enough (or they ask to finish), say a one-sentence thank-you and end your message with the exact token [[DONE]].`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!requireEnv(res, 'ANTHROPIC_API_KEY')) return;
  const user = await requireUser(req, res); if (!user) return;
  if (!(await quotaOr429(res, user.uid, 'chat'))) return;

  let body;
  try { body = await readJson(req); } catch { return res.status(400).json({ error: 'Bad JSON' }); }
  const mode = body.mode;
  const clip = (s, n) => String(s || '').slice(0, n);

  try {
    if (mode === 'brief') {
      const content = [];
      if (body.useStoredCv) {
        const cv = await db.get('cv:' + user.uid);
        if (cv && cv.mime === 'application/pdf') body.cvPdf = cv.b64;
        else if (cv) body.cvText = Buffer.from(cv.b64, 'base64').toString('utf8');
      }
      if (body.cvPdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: String(body.cvPdf) } });
      const notes = clip(body.notes, 20000);
      const cvText = clip(body.cvText, 40000);
      content.push({ type: 'text', text:
        (cvText ? `CV text:\n"""${cvText}"""\n\n` : '') +
        (notes ? `Extra notes / LinkedIn / portfolio the candidate pasted:\n"""${notes}"""\n\n` : '') +
        `Write a factual brief (max 220 words) of this candidate for an interviewer: current/past roles with company names, notable projects, skills, tools, years of experience, location, and open questions worth asking. Then return ONLY JSON: {"name": "first name or empty", "brief": "..."}` });
      const text = await claude({ model: MODELS.chat(), system: 'You extract accurate candidate briefs. Never invent details.', messages: [{ role: 'user', content }], maxTokens: 900 });
      const j = extractJson(text) || { name: '', brief: text };
      return res.status(200).json({ name: clip(j.name, 60), brief: clip(j.brief, 4000) });
    }

    if (mode === 'interview') {
      const history = (Array.isArray(body.messages) ? body.messages : []).slice(-40)
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
        .map(m => ({ role: m.role, content: clip(m.content, 4000) }));
      // The API needs the first message to be from the user.
      const messages = [{ role: 'user', content: '(The candidate has joined the call.)' }, ...history];
      if (messages[messages.length - 1].role === 'assistant') messages.push({ role: 'user', content: '(silence — please continue)' });
      const system = INTERVIEWER(clip(body.brief, 4000), clip(body.name, 60));
      let text = (await claude({ model: MODELS.chat(), system, messages, maxTokens: 300 })).trim();
      // Occasionally the model returns nothing (e.g. it declines a sensitive aside). Never hand the candidate an empty turn.
      if (!text.replace('[[DONE]]', '').trim() && !text.includes('[[DONE]]')) {
        const last = messages[messages.length - 1];
        const nudged = [...messages.slice(0, -1), { role: 'user', content: last.content + '\n\n(Interviewer note: acknowledge this briefly and neutrally, then ask your next interview question.)' }];
        text = (await claude({ model: MODELS.chat(), system, messages: nudged, maxTokens: 300 }).catch(() => '')).trim();
      }
      if (!text) text = 'Got it, I\'ve noted that. Let\'s keep going: what kind of team and work would make your next role feel like a real step up?';
      const done = text.includes('[[DONE]]');
      return res.status(200).json({ reply: text.replace('[[DONE]]', '').trim(), done });
    }

    if (mode === 'profile') {
      const transcript = (Array.isArray(body.messages) ? body.messages : []).slice(-60)
        .map(m => `${m.role === 'assistant' ? 'Radar' : 'Candidate'}: ${clip(m.content, 3000)}`).join('\n');
      const text = await claude({
        model: MODELS.chat(),
        system: 'You turn interviews into accurate candidate profiles for job matching. Only use what the brief and transcript support; leave fields empty rather than guessing. minMonthlyUSD defaults to 1000 if not stated.',
        messages: [{ role: 'user', content: `Brief:\n"""${clip(body.brief, 4000)}"""\n\nInterview:\n"""${transcript}"""\n\nReturn ONLY JSON in this shape:\n${PROFILE_SHAPE}` }],
        maxTokens: 1500
      });
      const profile = extractJson(text);
      if (!profile || typeof profile !== 'object') return res.status(502).json({ error: 'Could not build profile, try again' });
      return res.status(200).json({ profile });
    }

    return res.status(400).json({ error: 'Unknown mode' });
  } catch (e) {
    return res.status(e.status === 401 ? 502 : 502).json({ error: 'AI request failed: ' + e.message });
  }
};
