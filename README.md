# GitPixelPush

Paint your GitHub contribution graph. A hosted, multi-user web app: users sign
in with GitHub OAuth, paint pixels on their real contribution calendar, and
their own browser creates clearly labeled backdated commits through the GitHub
API. No server ever holds a user's token or data.

```
site/     Static frontend (host on GitHub Pages or Cloudflare Pages)
  index.html    Landing + canvas app
  privacy.html  Privacy policy
  styles.css    Glass design system + animations
  app.js        Canvas, tools, OAuth flow, browser-side commit engine
  config.js     ← you fill this in (client ID + Worker URL)
worker/   Cloudflare Worker (OAuth code → token exchange, the only server piece)
  worker.js
  wrangler.jsonc  ← you fill in vars
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

### 1. Create a GitHub OAuth App (2 minutes)

1. Go to **github.com/settings/developers → OAuth Apps → New OAuth App**.
2. Application name: `GitPixelPush` (or your fork's name).
3. Homepage URL: where the site will live, e.g. `https://YOURNAME.github.io/gitpixelpush/`.
4. Authorization callback URL: **the same URL** (the app redirects back to itself).
5. Register, then copy the **Client ID** and generate a **Client Secret**.

No verification process, no review queue. It works immediately for all users.

### 2. Deploy the Worker

```bash
cd worker
npx wrangler login                       # once
# edit wrangler.jsonc: set GITHUB_CLIENT_ID and ALLOWED_ORIGINS
npx wrangler deploy
npx wrangler secret put GITHUB_CLIENT_SECRET   # paste the secret when prompted
```

Note the deployed URL, e.g. `https://gitpixelpush-oauth.YOURNAME.workers.dev`.
`ALLOWED_ORIGINS` must list the exact origin(s) of the site, comma separated,
e.g. `https://YOURNAME.github.io`. Include `http://localhost:8080` while testing.

### 3. Configure the site

Edit `site/config.js`:

```js
window.GPP_CONFIG = {
  clientId: "<your OAuth app client ID>",
  exchangeUrl: "https://gitpixelpush-oauth.YOURNAME.workers.dev/exchange",
};
```

### 4. Host the site

**GitHub Pages:** push the contents of `site/` to a repo, then Settings →
Pages → Deploy from branch. **Cloudflare Pages:** create a project, root
directory `site/`, no build step. Either way, make sure the final URL matches
the OAuth app's homepage/callback URLs and the Worker's `ALLOWED_ORIGINS`.

### 5. Test locally

```bash
cd site && python3 -m http.server 8080   # → http://localhost:8080
```

GitHub OAuth apps allow one callback URL, so for local development either
create a second OAuth app ("GitPixelPush Dev") with callback
`http://localhost:8080/`, or just use the demo canvas (`#demo`), which needs
no sign-in at all.

## Notes

- Scopes are the minimum that works: `public_repo` + `read:user`. Private-repo
  painting would require the full `repo` scope; deliberately not requested.
- Commits are authored as `<id>+<login>@users.noreply.github.com` so they
  attribute to the signed-in account.
- The generated repo's README declares the commits are backdated graph art.
  Keep that. Transparency is the feature.
- GitHub's graph rescales its color quartiles as a user's max daily count
  changes, so the preview is a close approximation, not pixel-exact.
