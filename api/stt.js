// Speech → text with ElevenLabs Scribe. Body: { audio: base64, mime: "audio/webm" }  →  { text }
const { requireUser, requireEnv, readJson, quotaOr429 } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!requireEnv(res, 'ELEVENLABS_API_KEY')) return;
  const user = await requireUser(req, res); if (!user) return;
  if (!(await quotaOr429(res, user.uid, 'stt'))) return;

  let body;
  try { body = await readJson(req); } catch { return res.status(400).json({ error: 'Bad JSON' }); }
  const b64 = String(body.audio || '');
  if (!b64 || b64.length > 4_000_000) return res.status(400).json({ error: 'Audio missing or too long (keep answers under ~2 minutes)' });
  const mime = /^audio\/[\w.+-]+(;.*)?$/.test(body.mime || '') ? body.mime.split(';')[0] : 'audio/webm';
  const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm';

  try {
    const form = new FormData();
    form.append('model_id', process.env.ELEVENLABS_STT_MODEL || 'scribe_v1');
    form.append('language_code', 'en');
    form.append('file', new Blob([Buffer.from(b64, 'base64')], { type: mime }), 'answer.' + ext);
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, body: form, signal: AbortSignal.timeout(45000)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: 'Transcription failed: HTTP ' + r.status, detail: JSON.stringify(data).slice(0, 300) });
    return res.status(200).json({ text: String(data.text || '').trim() });
  } catch (e) {
    return res.status(502).json({ error: 'Transcription failed: ' + e.message });
  }
};
