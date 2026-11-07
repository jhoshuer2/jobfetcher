// Tells the page which features are configured (never returns the keys themselves).
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    passcode: !!process.env.APP_PASSCODE,
    claude: !!process.env.ANTHROPIC_API_KEY,
    voice: !!process.env.ELEVENLABS_API_KEY
  });
};
