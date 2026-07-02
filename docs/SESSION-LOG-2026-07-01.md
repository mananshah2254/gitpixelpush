# GitPixelPush build log · session of 2026-07-01 → 07-02

A record of the full build session: what was asked, what was built, what broke,
and how each thing was fixed. Written for future reference.

---

## 1. The original ask

Build a minimalist, award-worthy web app: sign in with GitHub, see your
contribution graph on the site, interactively select cells (individually, by
drawing, by date ranges) to plan how the graph should look, then transparently
run a script that creates backdated commits to paint it. Sleek, polished,
playful but professional.

## 2. Version 1: GreenPrint (local-only)

Built first as a local Flask app in `Portfolio/greenprint/` (kept, still works):

- **Auth**: borrows the `gh` CLI token via `gh auth token`, or a pasted PAT.
  Token held in server memory only.
- **Canvas**: real contribution calendar via GitHub GraphQL, rendered as a
  53×7 grid. Tools: paint, range, text (3×5 pixel font), erase, presets
  (heart, wave, checker, fill), undo/redo, ink density, tooltips.
- **Engine**: local git repo in `~/GreenPrint/<repo>`, empty commits with
  `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` set, pushed with a tokenized URL.
- **Design check**: the heatmap ramp was validated with the dataviz palette
  validator. GitHub's own level-1 green (#0e4429) fails 2:1 contrast on
  #0d1117, so it was nudged to **#115231** (2.05:1), visually identical.
  Final ramp: `#161b22, #115231, #006d32, #26a641, #39d353`.
- **Verification**: headless Chrome screenshots caught two real bugs (CSS
  specificity made all cells render empty; month labels collided). Engine
  core tested against a scratch repo.

## 3. The pivot: host it for other users

Key insight: the local design (server holds your token, shells out to git)
does not scale to multi-user. Rework decisions:

- **Auth** → real GitHub OAuth App (no verification queue, works instantly).
- **Engine** → GitHub **Git Data API from the user's browser**: chain
  backdated empty commit objects, then move the branch ref. No git binary,
  no server state, all traffic on the user's own rate limit.
- **Backend** → one ~100-line Cloudflare Worker whose only job is the OAuth
  code→token exchange (needs the client secret). Stores nothing.
- **Cost** → $0 at any scale (Workers free tier, static assets, user-side
  API traffic).

## 4. Version 2: GitPixelPush

New project `Portfolio/gitpixelpush/`, renamed per request, with a full glass
redesign:

- Frosted glass panels over drifting aurora gradients and floating pixels,
  3D tilt with cursor sheen (suspended while painting), magnetic buttons,
  sheen-sweep CTAs, staggered grid entrances, animated counters, shimmer
  progress bar, scroll reveals, hero teaser grid cycling "HI / ART / YOU",
  green pixel confetti on success. `prefers-reduced-motion` kills all of it.
- Landing page with instructions ("Three steps, no install"), an "Honest by
  design" transparency section, and a full dark-themed **privacy policy**
  (`/privacy`): no cookies, no analytics, no database, token in
  sessionStorage only.
- Execute modal shows the exact plan: repo, commit count, author email, and
  a verbatim sample of the API call, before anything runs.
- Demo canvas at `#demo`, no sign-in needed.

Later architectural simplification: **one Worker serves both the static site
and `/exchange`** (Workers assets), so site and API share one origin, CORS
became same-origin, and one custom domain covers everything.

## 5. Deployment saga (the debugging part)

1. **Repo**: private GitHub repo `mananshah2254/gitpixelpush` created and
   pushed. (It was accidentally deleted later in the session; recreated,
   still private, full history intact.)
2. **Domain**: `gitpixelpush.com` bought at GoDaddy. Nameservers switched to
   Cloudflare (free plan zone).
3. **Error 1**: deploy failed with a generic domains-changeset API error.
   Cause: Cloudflare's zone import copied **GoDaddy parking A records**
   (13.248.243.5, 76.223.105.230) that squatted the apex hostname the
   Workers custom domain needed. Fix: delete both A records. (Same trap that
   hit trailmails.com.)
4. **Error 2**: "Could not find zone for gitpixelpush.com". Cause: **account
   mismatch**: wrangler was logged into a different Cloudflare account than
   the one owning the zone. Fix: `wrangler logout` / `login` as the
   zone-owning account. Deploy then succeeded:
   `gitpixelpush.com (custom domain)`.
5. **Stale DNS**: local Mac resolver kept serving GoDaddy's parked page after
   everything was correct. Verified truth by curling Cloudflare's IP
   directly with `--resolve`. Fix for perception only:
   `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`.
6. **OAuth wiring**: GitHub OAuth App created (homepage
   `https://gitpixelpush.com`, callback `https://gitpixelpush.com/`), client
   ID `Ov23livKJU8WYZAOMXCG` wired into `config.js` + `wrangler.jsonc`,
   secret stored with `wrangler secret put GITHUB_CLIENT_SECRET`. Verified
   live: `/exchange` returned `bad_verification_code` for a bogus code,
   proving the client ID + secret pair reached GitHub correctly.

## 6. Feature: public/private repo choice

Request: let users choose repo visibility. Complication: the minimal
`public_repo` scope cannot create private repos; GitHub's only option is the
broad `repo` scope. Design shipped:

- Public stays the default on the minimal scope.
- A Public/Private segmented control in the push dialog. Choosing Private
  swaps the confirm button for **"Grant private access on GitHub"**, which
  re-runs OAuth asking for `repo`. The painted plan is parked in
  sessionStorage and restored (dialog reopened, Private preselected) after
  the round trip.
- UI and privacy policy explain the scope honestly, plus the caveat that
  private pixels only show if the profile's "Private contributions" setting
  is on.
- Along the way fixed a latent bug: `addEventListener("click", signIn)`
  would have passed the click event as the scope parameter.

## 7. Fix: GitHub secondary rate limit

A real run hit "You have exceeded a secondary rate limit". Diagnosis: the
engine fired writes as fast as GitHub answered (~3/sec); GitHub's abuse
detection wants ~1 write/second. Fix shipped:

- Commit creation paced to **1/second** (timed, subtracting request time).
- On a secondary-limit 403/429, the engine reads `retry-after`, logs a
  friendly line, **pauses and resumes by itself** (up to 4 retries).
- Checkpoints tightened from every 250 to **every 100 commits**.
- Progress line gained an ETA; dialog copy updated ("about one commit per
  second, the fastest GitHub allows for writes").
- Re-running a plan is safe by design: the engine only creates the
  difference between a day's existing count and the painted target.

## 8. Docs and comms

- README rewritten as a full plain-language document: stack table, ASCII
  architecture diagram, how sign-in works, how the canvas math works, how
  backdated commits are actually created and pushed (Git Data API, chaining,
  checkpoints), the Worker's two jobs, deploy guide, design notes, honest
  limitations.
- A LinkedIn launch post was drafted ("I built a website that lets you
  commit art fraud. Legally.") with the background-painting angle.

## 9. Where things stand

- **Live**: https://gitpixelpush.com (Worker + assets, custom domain, HTTPS).
- **Repo**: https://github.com/mananshah2254/gitpixelpush (private).
- **Working**: sign-in, canvas, painting tools, public/private choice,
  paced engine with auto-resume, demo mode, privacy page.
- **Remember**: after any code change, `npx wrangler deploy` from `worker/`
  is what updates the live site; pushing to GitHub alone does not.

## 10. Conventions to keep

- No em-dashes in site/marketing prose (user preference); commas and periods.
- Transparency is the product: labeled commits, honest README in generated
  repos, exact-plan dialog before anything runs. Do not regress these.
- Minimal OAuth scopes by default; broader scope only ever opt-in.
