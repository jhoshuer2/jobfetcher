# Radar

Talk to Radar for 10 minutes. It learns what you're great at and what you want, then every morning finds remote roles that clearly fit you, drafts a tailored application for each one, and — after you approve — sends the ones that take email from your own Gmail. For application forms it hands you a ready pack (cover letter + answers). Anything you apply to or pass on never comes back.

Open to anyone: sign in with Google, get 2 free applications, then buy credit packs (Paystack). Each person has their own profile, matches and applications.

## How it works

| Step | What happens |
| --- | --- |
| Sign in | Google sign-in with name + email only. **Connect Gmail** (optional, in Settings) adds `gmail.send` for one-tap sending; without it, approved emails open in the person's own email app. |
| Credits | 2 free drafted applications per person (`FREE_APPLICATIONS`), then 1 credit each. Packs via Paystack; credits are added only after Paystack confirms the payment, once per reference. Failed drafts are refunded. Owners (`OWNER_EMAILS`) are unlimited. |
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
   - **Branding**: app home page `https://YOUR-SITE.vercel.app`, privacy policy `https://YOUR-SITE.vercel.app/privacy.html`, terms `https://YOUR-SITE.vercel.app/terms.html`.
   - **Audience**: while testing, add test users. To open sign-in to everyone, click **Publish app**. Sign-in itself only uses basic scopes. `gmail.send` is a sensitive scope: until Google verifies the app, only up to 100 people can connect Gmail (they'll see an "unverified app" warning); everyone else uses "Open in my email app". Submit for verification from the same page when you're ready (needs your own domain and a short demo video).
4. **Clients / Credentials → Create credentials → OAuth client ID** → type **Web application**.
   - Authorized redirect URI: `https://YOUR-SITE.vercel.app/api/auth/callback`
   - Copy the **Client ID** and **Client secret**.

Note: while the app is in Testing, Google may expire Gmail connections after 7 days; people reconnect from Settings. Publishing the app removes that limit.

### 3. Environment variables
Vercel project → **Settings → Environment Variables**:

| Name | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | from step 2 |
| `GOOGLE_CLIENT_SECRET` | from step 2 |
| `SESSION_SECRET` | any long random string (e.g. 40+ random characters) |
| `CRON_SECRET` | another long random string (Vercel sends it to the daily run) |
| `OWNER_EMAILS` | your email(s); owners get unlimited applications |
| `PAYSTACK_SECRET_KEY` | Paystack dashboard → Settings → API Keys & Webhooks (use the `sk_test_…` key first, then `sk_live_…`) |
| `SUPPORT_EMAIL` | the contact address shown on the privacy and terms pages |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `ELEVENLABS_API_KEY` | elevenlabs.io → Developers → API Keys (Text to Speech + Speech to Text) |

Optional: `ALLOWED_EMAILS` (make it invite-only), `FREE_APPLICATIONS` (default 2), `PACKS` (JSON, e.g. `[{"id":"p5","apps":5,"amount":3000,"label":"Starter"}]`, amount in naira), `PAY_CURRENCY` (default `NGN`), `ELEVENLABS_VOICE_ID` (default Jessica), `CHAT_MODEL` / `DRAFT_MODEL` (default `claude-sonnet-5-5`), `MATCH_MODEL` (default `claude-haiku-5-5`), `LIMIT_MULTIPLIER` (scales the per-person daily limits), `APP_URL` (if you use a custom domain).

### 4. Paystack
1. Create an account at paystack.com and complete business verification (needed for live payments).
2. **Settings → API Keys & Webhooks**: copy the secret key into `PAYSTACK_SECRET_KEY`, and set **Webhook URL** to `https://YOUR-SITE.vercel.app/api/pay/webhook` (and the callback URL to `https://YOUR-SITE.vercel.app/api/pay/return`).
3. Test with Paystack's test cards on the `sk_test_` key, then switch to the live key.

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
| `api/pay/[action].js` | Paystack: packs, checkout, return, webhook |
| `api/tts.js`, `api/stt.js` | ElevenLabs voice |
| `privacy.html`, `terms.html` | Starter privacy policy and terms (review before launch) |
| `api/_lib.js`, `api/_jobs.js` | Shared helpers: database, sessions, encryption, Claude, Gmail, job sources, matching |
