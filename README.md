# Radar

Talk to Radar for 10 minutes. It learns what you're great at and what you want, then every morning finds remote roles that clearly fit you, drafts a tailored application for each one, and — after you approve — sends the ones that take email from your own Gmail. For application forms it hands you a ready pack (cover letter + answers). Anything you apply to or pass on never comes back.

Built for a small group of friends: everyone signs in with Google and gets their own profile, matches and applications.

## How it works

| Step | What happens |
| --- | --- |
| Sign in | Google sign-in. Radar asks permission to send email as you (`gmail.send`), used only when you tap Approve. |
| Interview | Upload a CV (PDF), paste LinkedIn/portfolio, then a voice (ElevenLabs) or typed conversation with Claude. Ends with an editable profile: roles, skills, country, minimum pay, dealbreakers. |
| Matching | Job sources are searched with everyone's interview roles. Each person only sees listings that fit their roles, can be done from their country, pay at least their minimum (or don't say), are ≤ 10 days since last advertised, and score ≥ their threshold (default 75). |
| Applying | For strong matches Claude drafts: an email (only when the listing itself asks for applications by email, to an address found in the listing) or a form pack. Nothing is sent without approval. Sent / applied / passed jobs are never suggested again. |
| Daily | Vercel Cron runs at ~7am Lagos time: refreshes jobs, scores, drafts, and emails each person a summary of what's ready. |

Job sources: Remotive, Jobicy, Remote OK, Himalayas, We Work Remotely, Working Nomads, Hacker News "Who is hiring", and Ashby/Greenhouse/Lever startup careers pages. Wellfound has no public API and blocks automated fetching.

## Setup (one time, ~20 minutes)

### 1. Database — Upstash Redis (free)
Vercel project → **Storage** → **Create Database** → **Upstash for Redis** (free plan) → connect it to this project. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.

### 2. Google sign-in + Gmail sending
1. Go to **console.cloud.google.com** → create a project (e.g. "Radar").
2. **APIs & Services → Library** → enable **Gmail API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform): User type **External**, app name "Radar", your email as support/developer contact.
   - **Data access / Scopes**: add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `.../auth/gmail.send`.
   - **Audience / Test users**: add your email and each friend's Google email (up to 100). Leave the app in **Testing** — no Google verification needed for test users.
4. **Clients / Credentials → Create credentials → OAuth client ID** → type **Web application**.
   - Authorized redirect URI: `https://YOUR-SITE.vercel.app/api/auth/callback`
   - Copy the **Client ID** and **Client secret**.

Note: in Testing mode Google shows an "app isn't verified" screen (click Continue) and may expire sign-ins after 7 days; people just sign in again.

### 3. Environment variables
Vercel project → **Settings → Environment Variables**:

| Name | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | from step 2 |
| `GOOGLE_CLIENT_SECRET` | from step 2 |
| `SESSION_SECRET` | any long random string (e.g. 40+ random characters) |
| `CRON_SECRET` | another long random string (Vercel sends it to the daily run) |
| `ALLOWED_EMAILS` | comma-separated emails allowed to sign in, e.g. `you@gmail.com, friend@gmail.com` |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `ELEVENLABS_API_KEY` | elevenlabs.io → Developers → API Keys (Text to Speech + Speech to Text) |

Optional: `ELEVENLABS_VOICE_ID` (default Jessica), `CHAT_MODEL` / `DRAFT_MODEL` (default `claude-sonnet-5-5`), `MATCH_MODEL` (default `claude-haiku-5-5`), `LIMIT_MULTIPLIER` (scales the per-person daily limits), `APP_URL` (if you use a custom domain).

Then **Deployments → ⋯ → Redeploy**. On the site, **Settings → Site status** should show everything ticked.

## Costs & limits
Everyone uses the owner's Claude and ElevenLabs keys. Per person per day: 120 interview turns, 120 voice clips each way, 200 jobs scored, 25 drafts, 15 sends. Multiply with `LIMIT_MULTIPLIER`.

## Files
| File | What it does |
| --- | --- |
| `index.html`, `app.js` | App shell, Matches, Review, Applied, Settings |
| `radar.js` | Landing, CV intake, voice/text interview, profile editor |
| `api/auth/[action].js` | Google sign-in / callback / logout |
| `api/me.js` | Your profile, interview, CV, settings, delete-my-data |
| `api/chat.js` | Claude: reads the CV, runs the interview, builds the profile |
| `api/jobs.js` | Your matches; `sync` refreshes jobs, scores and drafts |
| `api/apps.js` | Draft, edit, send (Gmail), mark applied / pass |
| `api/cron.js` | Daily run + summary email |
| `api/tts.js`, `api/stt.js` | ElevenLabs voice |
| `api/_lib.js`, `api/_jobs.js` | Shared helpers: database, sessions, encryption, Claude, Gmail, job sources, matching |
