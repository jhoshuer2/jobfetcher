// Text → speech with ElevenLabs. Body: { text }  →  audio/mpeg
const { requireUser, requireEnv, readJson, quotaOr429 } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!requireEnv(res, 'ELEVENLABS_API_KEY')) return;
  const user = await requireUser(req, res); if (!user) return;
  if (!(await quotaOr429(res, user.uid, 'tts'))) return;

  let body;
  try { body = await readJson(req); } catch { return res.status(400).json({ error: 'Bad JSON' }); }
  const text = String(body.text || '').slice(0, 1200).trim();
  if (!text) return res.status(400).json({ error: 'No text' });

  const voice = process.env.ELEVENLABS_VOICE_ID || 'cgSgspJ2msm6clMCkdW9'; // Jessica (premade)
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
      signal: AbortSignal.timeout(30000)
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ error: 'Voice failed: HTTP ' + r.status, detail: detail.slice(0, 300) });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(502).json({ error: 'Voice failed: ' + e.message });
  }
};
