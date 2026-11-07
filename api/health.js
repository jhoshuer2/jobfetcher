// Tells the page which features are configured (never returns the keys themselves).
const { missingEnv } = require('./_lib');

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const has = (...n) => !missingEnv(...n).length;
  res.status(200).json({
    signin: has('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET'),
    database: !!((process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) && (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)),
    claude: has('ANTHROPIC_API_KEY'),
    voice: has('ELEVENLABS_API_KEY'),
    daily: has('CRON_SECRET'),
    inviteOnly: has('ALLOWED_EMAILS')
  });
};
