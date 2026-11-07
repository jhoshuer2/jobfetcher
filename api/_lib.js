// Shared helpers for the API routes. Files starting with "_" are not exposed as endpoints by Vercel.

// Every AI/voice endpoint spends your credits, so they are locked behind APP_PASSCODE.
function checkAuth(req, res) {
  const need = process.env.APP_PASSCODE;
  if (!need) {
    res.status(501).json({ error: 'not_configured', missing: 'APP_PASSCODE' });
    return false;
  }
  if ((req.headers['x-passcode'] || '') !== need) {
    res.status(401).json({ error: 'bad_passcode' });
    return false;
  }
  return true;
}

function requireEnv(res, name) {
  if (!process.env[name]) {
    res.status(501).json({ error: 'not_configured', missing: name });
    return false;
  }
  return true;
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// Calls the Anthropic Messages API and returns the text of the reply.
async function claude({ model, system, messages, maxTokens = 1024 }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, system, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(55000)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || ('HTTP ' + r.status);
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// Pulls the first JSON object/array out of a model reply (tolerates ```json fences and stray prose).
function extractJson(text) {
  const t = String(text || '').replace(/```(?:json)?/g, '');
  const starts = [t.indexOf('{'), t.indexOf('[')].filter(i => i >= 0);
  if (!starts.length) return null;
  const s = Math.min(...starts);
  const open = t[s], close = open === '{' ? '}' : ']';
  const e = t.lastIndexOf(close);
  if (e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}

const MODELS = {
  chat: () => process.env.CHAT_MODEL || 'claude-sonnet-5-5',
  match: () => process.env.MATCH_MODEL || 'claude-haiku-5-5'
};

module.exports = { checkAuth, requireEnv, readJson, claude, extractJson, MODELS };
