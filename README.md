# Job Radar

Remote UI/UX and Claude Code jobs, $1k+/month, open to Nigeria. Listings drop off after 10 days unless re-advertised.

- `index.html`: the board (static page)
- `api/proxy.js`: Vercel function that fetches Remotive, Jobicy, Remote OK and Himalayas server-side, cached 6 hours

## Deploy

**Option A, GitHub (no terminal):** push this folder to a new GitHub repo, then on vercel.com click **Add New → Project**, import the repo, keep the defaults (Framework: Other) and click **Deploy**.

**Option B, terminal:** inside this folder run `npx vercel` and follow the prompts, then `npx vercel --prod`.
