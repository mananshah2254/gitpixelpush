# GitPixelPush

**Live at [gitpixelpush.com](https://gitpixelpush.com)**

Paint your GitHub contribution graph. Sign in with GitHub, see your real
contribution calendar as a canvas, draw on it (freehand, shapes, even words),
and GitPixelPush turns your drawing into real commits that appear as green
pixels on your profile.

It is honest about what it does: the commits are empty, clearly labeled, and
the repository they live in says in its README that it is graph art. Delete
that repo and every pixel disappears.

---

## What we used

| Piece | Choice | Why |
|---|---|---|
| Frontend | Plain HTML, CSS, JavaScript | No framework, no build step. The three files in `site/` are exactly what ships. |
| Backend | One Cloudflare Worker (~100 lines) | The only server code in the whole project. Free tier covers it forever. |
| Auth | GitHub OAuth App | Users click "Sign in with GitHub" and approve on GitHub's own page. No passwords, nothing to store. |
| Data | GitHub GraphQL API | Reads the user's contribution calendar (the 53×7 grid of counts). |
| Commits | GitHub Git Data API (REST) | Creates the backdated commits, from the user's browser, on the user's own rate limit. |
| Hosting | Cloudflare Workers static assets | The same Worker serves the site files and the one API endpoint. Domain `gitpixelpush.com` is attached as a Workers custom domain. |
| Fonts | Space Grotesk, Inter, JetBrains Mono | Via Google Fonts. |

There is **no database, no analytics, no cookies, and no server that stores
anything**. That is not a marketing line, it is the architecture.

AdSense ownership review is pending: the homepage has a publisher verification meta tag and `site/ads.txt` has the authorized-seller record. Neither loads ads or tracking today. If ads are enabled later, update this description, finish consent controls where required, and keep ads away from the OAuth and graph-painting controls.

## How it works, in one picture

```
 ┌──────────────┐  1. sign in           ┌─────────────┐
 │   Browser    │ ────────────────────▶ │   GitHub    │
 │ (the whole   │ ◀──────────────────── │   OAuth     │
 │  app runs    │  2. redirect + code   └─────────────┘
 │  here)       │
 │              │  3. code              ┌─────────────┐
 │              │ ────────────────────▶ │ Cloudflare  │   the ONLY backend:
 │              │ ◀──────────────────── │   Worker    │   swaps code for token,
 │              │  4. access token      └─────────────┘   stores nothing
 │              │
 │              │  5. read calendar, create repo,
 │              │     create commits, move branch
 │              │ ────────────────────▶ ┌─────────────┐
 └──────────────┘                       │ GitHub API  │
                                        └─────────────┘
```

Everything interesting happens in the user's own browser tab. The Worker
exists for exactly one step (3→4) because that step needs a secret.

## How sign-in works (simple version)

1. You click **Sign in with GitHub**. The site sends you to GitHub's own
   permission page, asking for two small permissions: `read:user` (to read
   your contribution calendar) and `public_repo` (to create one public repo
   and push to it).
2. GitHub sends you back to the site with a one-time **code** in the URL.
3. Turning that code into a real **access token** requires the app's client
   secret, which must never be in browser code. So the browser posts the code
   to our Cloudflare Worker, which holds the secret, asks GitHub for the
   token, and hands it straight back. The Worker does not log it, store it,
   or remember you.
4. The browser keeps the token in `sessionStorage`: it dies when you close
   the tab or sign out. Every GitHub API call after this goes directly from
   your browser to `api.github.com`.

If you choose a **private** canvas, the app sends you through GitHub once
more to ask for the broader `repo` scope, because GitHub has no narrower
permission that can create private repositories. That is opt-in only, and
your painted plan survives the round trip (it is parked in the browser and
restored afterwards).

## How the canvas works

- The app asks GitHub's GraphQL API for your **contribution calendar**: for
  each of the last ~371 days, the date and how many contributions you made.
- Each day becomes a cell in a 53-column × 7-row grid, colored with GitHub's
  green scale (we nudged the darkest green slightly lighter so it passes a
  contrast check against the dark background; visually identical).
- You paint **target levels 1 to 4** onto days, with four tools: freehand
  Paint, a Range tool for rectangles of dates, a Text tool that stamps words
  using a 3×5 pixel font, and Erase. Plus presets (heart, wave, checker,
  fill), undo/redo, and keyboard shortcuts.
- **Ink density** decides how many commits a level means. In "Auto" it looks
  at your busiest day of the year and scales so painted pixels sit
  believably next to your real activity. Example: if your max day is 12
  contributions, one "unit" is 3, so level 4 targets 12 commits.
- The app only ever creates the **difference**. If a day already has 5
  contributions and your painted level targets 6, it plans exactly 1 commit.
  If the day already meets the target, it plans 0. This also means an
  interrupted run can simply be run again without double-painting.

## How the commits are triggered (the core trick, in simple language)

A commit on GitHub is just a small object with a message, a pointer to a
file tree, a parent commit, and **two timestamps that the committer supplies
themselves**: the author date and the commit date. Git has always worked
this way; `git commit` normally fills in "now", but nothing requires that.
GitHub draws your contribution graph from those supplied dates.

GitPixelPush uses GitHub's **Git Data API** to build commits directly, no
git installed, no clone, straight from the browser:

1. **Create (or reuse) one repository** with an auto-generated first commit.
2. **Write an honest README** into the repo's file tree, stating that
   everything in it is intentionally backdated graph art.
3. **Chain the pixel commits.** For every planned commit, the browser sends
   one API request: "create a commit with this message
   (`gitpixelpush: pixel 2026-03-04 (1/6)`), this tree (unchanged, so the
   commit is empty), this parent (the previous commit), and this author date
   (the painted day, with times spread across a working day)". Each response
   returns the new commit's ID, which becomes the parent of the next one.
4. **Move the branch.** Creating commit objects alone changes nothing
   visible. Every 100 commits, and at the end, the browser moves the `main`
   branch pointer to the newest commit. That is the actual "push", and it is
   why progress sticks even if you stop midway or your laptop dies.
5. GitHub notices the new commits on the default branch, sees their author
   dates and the author email (`<id>+<login>@users.noreply.github.com`, which
   ties them to your account), and redraws your graph within a minute or two.

Pacing matters: GitHub allows roughly **one write request per second**
before its abuse detection ("secondary rate limit") kicks in. The engine
paces itself to that, shows a live ETA, and if GitHub still says "slow
down", it pauses for exactly as long as GitHub asks and resumes by itself.
A single run is capped at 4,000 commits to stay inside GitHub's 5,000
requests/hour budget.

## How the backend works (all of it)

The entire backend is `worker/worker.js`, a Cloudflare Worker with two jobs:

1. **Serve the static site.** The files in `site/` are uploaded as assets and
   served from Cloudflare's edge. A request to `/` gets `index.html`,
   `/privacy` gets the privacy policy, and so on.
2. **`POST /exchange`.** Receives `{ code }`, calls GitHub's
   `login/oauth/access_token` with the client ID and the client secret (kept
   as an encrypted Worker secret, never in the code or the repo), and returns
   `{ access_token, scope }` to the browser. It checks the request's Origin
   against an allowlist, stores nothing, and has no other endpoints.

That's the whole backend. It cannot leak user data because it never holds
any.

## Repository layout

```
site/
  index.html    Landing page + the canvas app (one page, two views)
  app.js        Everything: OAuth flow, calendar, painting tools,
                undo/redo, the commit engine, animations
  styles.css    Dark glass design system, validated green ramp, animations
  privacy.html  Privacy policy
  config.js     Deployment config: OAuth client ID + exchange URL
worker/
  worker.js     The Cloudflare Worker described above
  wrangler.jsonc  Worker config: name, assets dir, custom domain, vars
```

## Deploying your own

1. **Worker + site**
   ```bash
   cd worker
   npx wrangler login
   npx wrangler deploy
   ```
   This serves the site and `/exchange` at `https://gitpixelpush.<you>.workers.dev`.
   For a custom domain, put your zone on Cloudflare and set the `routes` line
   in `wrangler.jsonc`.

2. **GitHub OAuth App** (github.com/settings/developers → New OAuth App):
   Homepage `https://your-domain`, callback `https://your-domain/` (trailing
   slash matters, it must match what the app sends). Copy the Client ID,
   generate a Client Secret.

3. **Wire credentials**
   ```bash
   npx wrangler secret put GITHUB_CLIENT_SECRET   # paste the secret
   ```
   Put the Client ID in `site/config.js` and in `wrangler.jsonc` vars, then
   `npx wrangler deploy` once more.

4. **Local development**
   ```bash
   cd worker && npx wrangler dev   # site + exchange on http://localhost:8787
   ```
   Or skip sign-in entirely with the demo canvas: open the site with `#demo`.

## Design notes

- Dark glass UI: frosted panels (`backdrop-filter`) over drifting aurora
  gradients and floating pixels, 3D tilt with a light sheen that follows the
  cursor (suspended while you paint so the grid stays steady), magnetic
  buttons, staggered reveals, animated counters, and green pixel confetti on
  success. All of it collapses gracefully under `prefers-reduced-motion`.
- The green heatmap ramp was validated with a color checker (lightness
  monotone, adjacent contrast steps, colorblind-safe single hue, light end
  clears the surface). Planned cells are marked with a ring, not color alone,
  and tooltips carry the exact numbers.
- The Text tool's font is a hand-defined 3×5 pixel alphabet that fits rows
  1–5 of the 7-row graph.

## Honest limitations

- **It fabricates activity, and says so.** The repo README, the commit
  messages, and this document all state it plainly. Anyone inspecting the
  repo sees empty, labeled, backdated commits. Use it as art, not as a fake
  work history.
- GitHub rescales its green color thresholds as your busiest day changes, so
  the preview is a very close approximation, not pixel-exact.
- Private-repo pixels only appear on your graph if "Private contributions"
  is enabled in your GitHub profile's contribution settings.
- Big plans take time: roughly one commit per second is GitHub's speed limit
  for writes, so a 2,000-commit mural is about a 35-minute run. You can stop
  anytime; progress up to the last checkpoint stays.

## Privacy

See [gitpixelpush.com/privacy](https://gitpixelpush.com/privacy). Short
version: no cookies, no analytics, no database, token lives in your tab and
dies with it, and you can revoke the app at
[github.com/settings/applications](https://github.com/settings/applications)
anytime.
