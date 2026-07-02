# GitPixelPush

Paint your GitHub contribution graph. A hosted, multi-user web app: users sign
in with GitHub OAuth, paint pixels on their real contribution calendar, and
their own browser creates clearly labeled backdated commits through the GitHub
API. No server ever holds a user's token or data.

```
site/     Static frontend, served as Worker assets
  index.html    Landing + canvas app
  privacy.html  Privacy policy
  styles.css    Glass design system + animations
  app.js        Canvas, tools, OAuth flow, browser-side commit engine
  config.js     ← you fill in the OAuth client ID
worker/   One Cloudflare Worker: serves site/ AND the /exchange endpoint
  worker.js
  wrangler.jsonc  ← you fill in GITHUB_CLIENT_ID (and the custom domain route)
```

## Architecture in one paragraph

The site is static. Signing in redirects to GitHub's OAuth page; GitHub
redirects back with a `code`; the browser posts that code to the Worker, which
swaps it for an access token using the client secret and returns it. From then
on the browser talks to `api.github.com` directly: it reads the contribution
calendar over GraphQL, creates one public repo, chains backdated empty commit
objects through the Git Data API, and moves the branch ref (with a checkpoint
every 250 commits, so even an interrupted run keeps its progress). The 4,000
commit cap per run stays inside GitHub's 5,000 requests/hour budget.

## Setup

### 1. Deploy the Worker (site included)

```bash
cd worker
npx wrangler login       # once
npx wrangler deploy      # serves site/ + /exchange at https://gitpixelpush.<you>.workers.dev
```

### 2. Attach the domain

Have the `gitpixelpush.com` zone on your Cloudflare account (automatic if
bought via Cloudflare Registrar; otherwise add the site in the dashboard and
point the registrar's nameservers at Cloudflare). Then uncomment the
`routes` line in `wrangler.jsonc` and `npx wrangler deploy` again. Cloudflare
provisions DNS and the certificate for you.

### 3. Create a GitHub OAuth App (2 minutes)

1. Go to **github.com/settings/developers → OAuth Apps → New OAuth App**.
2. Application name: `GitPixelPush`.
3. Homepage URL: `https://gitpixelpush.com`.
4. Authorization callback URL: `https://gitpixelpush.com/` (the app redirects back to itself).
5. Register, copy the **Client ID**, generate a **Client Secret**.

No verification process, no review queue. It works immediately for all users.

### 4. Wire in the credentials

```bash
# the secret goes to Cloudflare, never into git:
npx wrangler secret put GITHUB_CLIENT_SECRET   # paste when prompted
```

Put the Client ID (public) in two places, then deploy once more:
`site/config.js` → `clientId`, and `worker/wrangler.jsonc` → `GITHUB_CLIENT_ID`.

### 5. Test locally

```bash
cd worker && npx wrangler dev    # → http://localhost:8787, site + exchange together
```

GitHub OAuth apps allow one callback URL, so for local sign-in testing create
a second OAuth app ("GitPixelPush Dev") with callback `http://localhost:8787/`,
or just use the demo canvas (`#demo`), which needs no sign-in at all.

## Notes

- Scopes are the minimum that works: `public_repo` + `read:user`. Private-repo
  painting would require the full `repo` scope; deliberately not requested.
- Commits are authored as `<id>+<login>@users.noreply.github.com` so they
  attribute to the signed-in account.
- The generated repo's README declares the commits are backdated graph art.
  Keep that. Transparency is the feature.
- GitHub's graph rescales its color quartiles as a user's max daily count
  changes, so the preview is a close approximation, not pixel-exact.
