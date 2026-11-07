// The "Meet Radar" interviewer. Three modes:
//   brief     – read a CV (PDF or text) + pasted notes, return {name, brief}
//   interview – next interviewer turn, given the brief and the conversation so far
//   profile   – turn the brief + conversation into a structured profile JSON
const { checkAuth, requireEnv, readJson, claude, extractJson, MODELS } = require('./_lib');

const PROFILE_SHAPE = `{
  "name": "", "headline": "one line, e.g. 'Product designer & AI builder'",
  "summary": "3-4 sentences in second person about who they are and what they're great at",
  "roles": ["job titles they'd be a strong fit for"],
  "skills": [""], "tools": [""],
  "seniority": "junior | mid | senior | lead",
  "years": 0,
  "workTypes": ["full-time","contract","freelance","fractional","advisory","expert calls"],
  "minMonthlyUSD": 1000,
  "hours": "availability / time-zone notes",
  "strengths": ["evidence-backed strengths, each with the proof"],
  "interests": ["domains/problems they want to work on"],
  "dealbreakers": [""],
  "keywords": ["search words to find matching jobs"]
}`;

const INTERVIEWER = (brief, name) => `You are Radar, a warm, sharp career interviewer (in the spirit of an expert-network voice agent). You are speaking out loud with ${name || 'the candidate'}, a professional based in Nigeria who wants remote work paying at least $1,000/month, mainly UI/UX & product design and Claude Code / AI-assisted building.

What you already know from their CV and notes:
"""
${brief || '(nothing yet — learn it from the conversation)'}
"""

Your job: in about 8–12 questions, understand them deeply enough to match them to full-time roles, contracts, fractional work, advisory, expert calls and research projects.
Cover, in a natural order: the story behind their best work; one or two projects in depth (their exact role, decisions, trade-offs, results); design + building skills and tools (Figma, design systems, Claude Code, front-end); seniority and team experience; the kinds of work they're open to; minimum monthly pay; hours/time-zone constraints; what they want next; dealbreakers.

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
  if (!checkAuth(req, res) || !requireEnv(res, 'ANTHROPIC_API_KEY')) return;

  let body;
  try { body = await readJson(req); } catch { return res.status(400).json({ error: 'Bad JSON' }); }
  const mode = body.mode;
  const clip = (s, n) => String(s || '').slice(0, n);

  try {
    if (mode === 'brief') {
      const content = [];
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
      const text = await claude({ model: MODELS.chat(), system: INTERVIEWER(clip(body.brief, 4000), clip(body.name, 60)), messages, maxTokens: 300 });
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
