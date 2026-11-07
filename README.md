# Job Radar

Remote UI/UX and Claude Code jobs, $1k+/month, open to Nigeria. Listings drop off after 10 days unless re-advertised.
**Meet Radar** is a short voice interview (Claude + ElevenLabs) that reads your CV, asks follow-up questions, builds a profile, and scores every job on the board for you.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `app.js` | The board: sources, 10-day rule, filters, match scores |
| `radar.js` | Meet Radar: CV intake, voice/text interview, profile editor |
| `api/proxy.js` | Fetches job feeds server-side (allowlisted hosts, cached 6 h) |
| `api/chat.js` | Claude: reads the CV, runs the interview, builds the profile |
| `api/match.js` | Claude: scores jobs against your profile |
| `api/tts.js`, `api/stt.js` | ElevenLabs voice out / speech to text |
| `api/health.js` | Tells the Setup page which keys are configured |

## Job sources

Remotive, Jobicy, Remote OK, Himalayas, We Work Remotely (RSS), Working Nomads, Hacker News "Who is hiring", and startup careers pages on Ashby, Greenhouse and Lever (edit the list on the Setup page). Wellfound has no public API and blocks automated fetching, so it isn't included directly; many Wellfound startups post on those same Ashby/Greenhouse/Lever pages.

## Setup on Vercel (one time)

In your Vercel project → **Settings → Environment Variables**, add:

| Name | Value |
| --- | --- |
| `APP_PASSCODE` | Any password you choose. It stops other people spending your credits. |
| `ANTHROPIC_API_KEY` | From console.anthropic.com → API Keys |
| `ELEVENLABS_API_KEY` | From elevenlabs.io → Developers → API Keys (needs Text to Speech + Speech to Text access) |

Optional: `ELEVENLABS_VOICE_ID` (default: Jessica, a built-in voice), `CHAT_MODEL` (default `claude-sonnet-5-5`), `MATCH_MODEL` (default `claude-haiku-5-5`).

Then **Deployments → ⋯ → Redeploy** so the new variables load. On the live site, open **Setup**, enter the same passcode, and check all items are ticked.

Everything you enter (CV, interview, profile, saved jobs) stays in your browser; the server only passes it to Claude/ElevenLabs to answer each request.
