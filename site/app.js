/* GitPixelPush. Static, serverless, honest.
   Auth: GitHub OAuth (code exchanged by a tiny Worker relay).
   Engine: commits are created in YOUR browser via GitHub's Git Data API. */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const CFG = window.GPP_CONFIG || {};
const API = "https://api.github.com";
const MAX_COMMITS = 4000;      // keeps a run inside GitHub's 5000 req/hour budget
const CHECKPOINT_EVERY = 100;  // move the branch every N commits so progress sticks
const PACE_MS = 1000;          // GitHub's secondary rate limit wants ~1 write/second

/* ────────────────────────── state ────────────────────────── */
const S = {
  demo: false,
  user: null,               // {login, id, name, avatar_url}
  days: [], byDate: new Map(), cells: new Map(),
  maxCount: 0,
  plan: new Map(),           // date -> level 1..4
  tool: "paint", brush: 3, density: "auto",
  undo: [], redo: [],
  stroking: false, rectAnchor: null, ghost: new Set(),
  abort: false, running: false,
  private: false,
};

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const RAMP = ["#115231", "#006d32", "#26a641", "#39d353"];

/* 3×5 pixel font for the text tool */
const FONT = {
  A:["010","101","111","101","101"], B:["110","101","110","101","110"],
  C:["011","100","100","100","011"], D:["110","101","101","101","110"],
  E:["111","100","110","100","111"], F:["111","100","110","100","100"],
  G:["011","100","101","101","011"], H:["101","101","111","101","101"],
  I:["111","010","010","010","111"], J:["001","001","001","101","010"],
  K:["101","110","100","110","101"], L:["100","100","100","100","111"],
  M:["101","111","111","101","101"], N:["101","111","111","111","101"],
  O:["010","101","101","101","010"], P:["110","101","110","100","100"],
  Q:["010","101","101","011","001"], R:["110","101","110","101","101"],
  S:["011","100","010","001","110"], T:["111","010","010","010","010"],
  U:["101","101","101","101","111"], V:["101","101","101","101","010"],
  W:["101","101","111","111","101"], X:["101","101","010","101","101"],
  Y:["101","101","010","010","010"], Z:["111","001","010","100","111"],
  "0":["111","101","101","101","111"], "1":["010","110","010","010","111"],
  "2":["110","001","010","100","111"], "3":["111","001","011","001","111"],
  "4":["101","101","111","001","001"], "5":["111","100","110","001","110"],
  "6":["011","100","111","101","111"], "7":["111","001","010","010","010"],
  "8":["111","101","111","101","111"], "9":["111","101","111","001","110"],
  "!":["010","010","010","000","010"], "?":["110","001","010","000","010"],
  ".":["000","000","000","000","010"], "-":["000","000","111","000","000"],
  " ":["0","0","0","0","0"],
};

/* ────────────────────────── GitHub API ────────────────────────── */
const token = () => sessionStorage.getItem("gpp_token");
const configured = () => CFG.clientId && !String(CFG.clientId).startsWith("YOUR_");

async function gh(path, { method = "GET", body } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { signOut(); throw Object.assign(new Error("GitHub signed you out, please sign in again."), { status: 401 }); }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const err = Object.assign(new Error(data.message || `GitHub API error ${r.status}`), { status: r.status });
    err.retryAfter = Number(r.headers.get("retry-after")) || null;
    err.secondary = (r.status === 403 || r.status === 429) && /secondary rate limit/i.test(err.message);
    if (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0") {
      const reset = new Date(Number(r.headers.get("x-ratelimit-reset")) * 1000);
      err.message = `GitHub's hourly API limit is used up. It resets at ${reset.toLocaleTimeString()}. Progress so far is already on your graph.`;
    }
    throw err;
  }
  return r.status === 204 ? null : r.json();
}

const CONTRIB_QUERY = `query { viewer { contributionsCollection { contributionCalendar {
  totalContributions weeks { contributionDays { date contributionCount weekday } } } } } }`;

async function fetchCalendar() {
  const data = await gh("/graphql", { method: "POST", body: { query: CONTRIB_QUERY } });
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data.viewer.contributionsCollection.contributionCalendar;
}

/* ────────────────────────── auth ────────────────────────── */
function hasRepoScope() {
  return (sessionStorage.getItem("gpp_scope") || "").split(/[,\s]+/).includes("repo");
}

function signIn(scope = "public_repo read:user") {
  const state = crypto.randomUUID();
  sessionStorage.setItem("gpp_state", state);
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", CFG.clientId);
  u.searchParams.set("scope", scope);
  u.searchParams.set("state", state);
  u.searchParams.set("redirect_uri", location.origin + location.pathname);
  location.href = u.toString();
}

async function handleOAuthRedirect() {
  const q = new URLSearchParams(location.search);
  const code = q.get("code");
  if (!code) return false;
  const stateOk = q.get("state") && q.get("state") === sessionStorage.getItem("gpp_state");
  sessionStorage.removeItem("gpp_state");
  history.replaceState({}, "", location.pathname);
  if (!stateOk) { authError("Sign-in state check failed. Please try again."); return false; }
  try {
    const r = await fetch(CFG.exchangeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await r.json();
    if (!data.access_token) throw new Error(data.error || "no token returned");
    sessionStorage.setItem("gpp_token", data.access_token);
    sessionStorage.setItem("gpp_scope", data.scope || "");
    return true;
  } catch (e) {
    authError("Could not finish sign-in: " + e.message);
    return false;
  }
}

function signOut() {
  sessionStorage.removeItem("gpp_token");
  location.hash = "";
  location.reload();
}

function authError(msg) { const el = $("#auth-error"); el.textContent = msg; el.hidden = false; }

/* ────────────────────────── demo data ────────────────────────── */
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function demoCalendar() {
  const rng = mulberry32(42);
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - start.getDay() - 52 * 7);
  const weeks = []; let total = 0;
  const d = new Date(start);
  while (d <= today) {
    const days = [];
    for (let wd = 0; wd < 7 && d <= today; wd++) {
      let c = 0;
      const dow = d.getDay();
      if (dow > 0 && dow < 6 && rng() < 0.55) c = [1, 1, 2, 2, 3, 4, 5, 8][Math.floor(rng() * 8)];
      total += c;
      days.push({ date: d.toISOString().slice(0, 10), contributionCount: c, weekday: wd });
      d.setDate(d.getDate() + 1);
    }
    weeks.push({ contributionDays: days });
  }
  return { totalContributions: total, weeks };
}

/* ────────────────────────── grid model ────────────────────────── */
function unit() { return S.density === "auto" ? Math.max(1, Math.ceil(S.maxCount / 4)) : Number(S.density); }
function addedCommits(date) {
  const level = S.plan.get(date);
  return level ? Math.max(0, level * unit() - S.byDate.get(date).count) : 0;
}
function levelOf(count) { return count <= 0 ? 0 : Math.min(4, Math.ceil(count / unit())); }
function fmtDate(iso) { const d = new Date(iso + "T12:00:00"); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; }

function buildGrid(calendar) {
  const grid = $("#grid");
  grid.innerHTML = "";
  S.days = []; S.byDate.clear(); S.cells.clear(); S.maxCount = 0;

  calendar.weeks.forEach((w, col) => {
    const have = new Map(w.contributionDays.map((d) => [d.weekday, d]));
    for (let row = 0; row < 7; row++) {
      const d = have.get(row);
      if (!d) {
        const pad = document.createElement("div");
        pad.className = "cell future";
        pad.style.visibility = "hidden";
        grid.appendChild(pad);
        continue;
      }
      const day = { date: d.date, count: d.contributionCount, weekday: row, col };
      S.days.push(day); S.byDate.set(d.date, day);
      S.maxCount = Math.max(S.maxCount, day.count);
      const el = document.createElement("div");
      el.className = "cell";
      el.dataset.date = d.date;
      el.style.setProperty("--ad", `${col * 9}ms`);   // staggered entrance
      grid.appendChild(el);
      S.cells.set(d.date, el);
    }
  });

  buildMonthRow(calendar.weeks);
  repaintAll();
  $("#canvas-sub").textContent =
    `${calendar.totalContributions.toLocaleString()} contributions in the last year. Click and drag to paint the future you wish you had.`;
}

function buildMonthRow(weeks) {
  const row = $("#month-row");
  row.innerHTML = "";
  row.style.gridTemplateColumns = `repeat(${weeks.length}, 16px)`;
  const candidates = [];
  let last = -1;
  weeks.forEach((w, i) => {
    const first = w.contributionDays[0];
    if (!first) return;
    const m = new Date(first.date + "T12:00:00").getMonth();
    if (m !== last && i < weeks.length - 2) { candidates.push({ col: i, m }); last = m; }
  });
  candidates.filter((c, i) => !candidates[i + 1] || candidates[i + 1].col - c.col >= 3)
    .forEach(({ col, m }) => {
      const s = document.createElement("span");
      s.textContent = MONTHS[m];
      s.style.gridColumn = String(col + 1);
      row.appendChild(s);
    });
}

function paintCell(date) {
  const el = S.cells.get(date);
  const day = S.byDate.get(date);
  const combined = day.count + addedCommits(date);
  const lvl = S.plan.has(date) ? Math.max(levelOf(combined), S.plan.get(date)) : levelOf(combined);
  el.className = "cell l" + lvl
    + (S.plan.has(date) ? " planned" : "")
    + (S.ghost.has(date) ? " ghost" : "");
}
function repaintAll() { for (const d of S.byDate.keys()) paintCell(d); updateStats(); }

/* animated counters */
const counters = new Map();
function tweenStat(el, target) {
  const from = counters.get(el) ?? 0;
  counters.set(el, target);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || from === target) {
    el.textContent = target.toLocaleString(); return;
  }
  const t0 = performance.now(), dur = 350;
  (function tick(t) {
    const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (target - from) * e).toLocaleString();
    if (p < 1) requestAnimationFrame(tick);
  })(t0);
}

function updateStats() {
  let commits = 0;
  for (const date of S.plan.keys()) commits += addedCommits(date);
  tweenStat($("#stat-cells"), S.plan.size);
  tweenStat($("#stat-commits"), commits);
  if (S.plan.size) {
    const dates = [...S.plan.keys()].sort();
    $("#stat-span").textContent = `${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}`;
  } else $("#stat-span").textContent = "–";
  const btn = $("#btn-execute");
  btn.disabled = S.demo || commits === 0;
  btn.title = S.demo ? "Demo mode. Sign in to push for real." : "";
  $("#btn-undo").disabled = !S.undo.length;
  $("#btn-redo").disabled = !S.redo.length;
}

/* ────────────────────────── undo/redo ────────────────────────── */
const snapshot = () => [...S.plan.entries()];
function pushUndo() { S.undo.push(snapshot()); if (S.undo.length > 120) S.undo.shift(); S.redo = []; }
function restore(snap) { S.plan = new Map(snap); repaintAll(); }
function doUndo() { if (S.undo.length) { S.redo.push(snapshot()); restore(S.undo.pop()); } }
function doRedo() { if (S.redo.length) { S.undo.push(snapshot()); restore(S.redo.pop()); } }

/* ────────────────────────── painting ────────────────────────── */
function applyBrush(date, popIt = true) {
  if (!S.byDate.has(date)) return;
  if (S.tool === "erase") S.plan.delete(date);
  else S.plan.set(date, S.brush);
  paintCell(date);
  if (popIt) {
    const el = S.cells.get(date);
    el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
  }
  updateStats();
}

function cellFromEvent(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  return el?.classList?.contains("cell") && el.dataset.date ? el.dataset.date : null;
}

function rectDates(a, b) {
  const A = S.byDate.get(a), B = S.byDate.get(b);
  const [c0, c1] = [Math.min(A.col, B.col), Math.max(A.col, B.col)];
  const [r0, r1] = [Math.min(A.weekday, B.weekday), Math.max(A.weekday, B.weekday)];
  return S.days.filter((d) => d.col >= c0 && d.col <= c1 && d.weekday >= r0 && d.weekday <= r1)
               .map((d) => d.date);
}

function textDates(anchorDate, text) {
  const anchor = S.byDate.get(anchorDate);
  const out = [];
  let col = anchor.col;
  for (const ch of text.toUpperCase()) {
    const glyph = FONT[ch];
    if (!glyph) continue;
    for (let c = 0; c < glyph[0].length; c++)
      for (let r = 0; r < 5; r++) {
        if (glyph[r][c] !== "1") continue;
        const day = S.days.find((d) => d.col === col + c && d.weekday === r + 1);
        if (day) out.push(day.date);
      }
    col += glyph[0].length + 1;
  }
  return out;
}

function setGhost(dates) {
  const next = new Set(dates);
  for (const d of S.ghost) if (!next.has(d)) { S.ghost.delete(d); paintCell(d); }
  for (const d of next) if (!S.ghost.has(d)) { S.ghost.add(d); paintCell(d); }
}

function showTooltip(e, date) {
  const t = $("#tooltip");
  const day = S.byDate.get(date);
  const add = addedCommits(date);
  const planned = S.plan.has(date)
    ? (add > 0 ? ` · <b style="color:var(--accent)">+${add} planned</b>`
               : ` · <span class="dim">already at this level</span>`)
    : "";
  t.innerHTML = `<b>${fmtDate(date)}</b> <span class="dim">·</span> ${day.count} existing${planned}`;
  t.style.left = e.clientX + "px";
  t.style.top = e.clientY + "px";
  t.hidden = false;
}
const hideTooltip = () => { $("#tooltip").hidden = true; };

function wireGrid() {
  const grid = $("#grid");

  grid.addEventListener("pointerdown", (e) => {
    const date = cellFromEvent(e);
    if (!date) return;
    e.preventDefault();
    grid.setPointerCapture(e.pointerId);
    if (S.tool === "rect") {
      S.rectAnchor = date; S.stroking = true;
      setGhost(rectDates(date, date));
    } else if (S.tool === "text") {
      const text = $("#text-input").value.trim();
      if (!text) { $("#text-input").focus(); return; }
      pushUndo(); setGhost([]);
      for (const d of textDates(date, text)) { S.plan.set(d, S.brush); paintCell(d); }
      updateStats();
    } else {
      pushUndo(); S.stroking = true;
      applyBrush(date);
    }
  });

  grid.addEventListener("pointermove", (e) => {
    const date = cellFromEvent(e);
    if (date) showTooltip(e, date); else hideTooltip();
    if (S.stroking && date) {
      if (S.tool === "rect") setGhost(rectDates(S.rectAnchor, date));
      else applyBrush(date, false);
    } else if (S.tool === "text" && date) {
      const text = $("#text-input").value.trim();
      setGhost(text ? textDates(date, text) : []);
    }
  });

  grid.addEventListener("pointerup", (e) => {
    if (S.tool === "rect" && S.stroking) {
      const date = cellFromEvent(e) || S.rectAnchor;
      pushUndo();
      const dates = rectDates(S.rectAnchor, date);
      setGhost([]);
      for (const d of dates) { S.plan.set(d, S.brush); paintCell(d); }
      updateStats();
    }
    S.stroking = false; S.rectAnchor = null;
  });

  grid.addEventListener("pointerleave", () => { hideTooltip(); if (!S.stroking) setGhost([]); });
}

/* ────────────────────────── toolbar ────────────────────────── */
function setTool(tool) {
  S.tool = tool;
  $$(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  $("#text-input").hidden = tool !== "text";
  if (tool === "text") $("#text-input").focus();
  setGhost([]);
}
function setBrush(level) {
  S.brush = level;
  $$(".brush").forEach((b) => b.classList.toggle("active", Number(b.dataset.level) === level));
}

const PRESETS = {
  heart(cols) {
    return { art: ["01100110","11111111","11111111","01111110","00111100","00011000","00000000"],
             start: Math.floor((cols - 8) / 2) };
  },
  wave(cols) {
    const art = Array.from({ length: 7 }, () => "0".repeat(cols).split(""));
    for (let c = 0; c < cols; c++) {
      const r = Math.round(3 + 2.4 * Math.sin(c / 3.2));
      art[r][c] = "1";
      if (art[r + 1]) art[r + 1][c] = "1";
    }
    return { art: art.map((r) => r.join("")), start: 0 };
  },
  checker(cols) {
    return { art: Array.from({ length: 7 }, (_, r) =>
      Array.from({ length: cols }, (_, c) => ((r + c) % 2 ? "1" : "0")).join("")), start: 0 };
  },
  fill(cols) {
    return { art: Array.from({ length: 7 }, () => "1".repeat(cols)), start: 0 };
  },
};

function applyPreset(name) {
  const cols = Math.max(...S.days.map((d) => d.col)) + 1;
  const { art, start } = PRESETS[name](cols);
  pushUndo();
  for (const day of S.days) {
    const c = day.col - start;
    if (c < 0 || c >= art[0].length) continue;
    if (art[day.weekday][c] === "1") S.plan.set(day.date, S.brush);
  }
  repaintAll();
}

function wireToolbar() {
  $$(".tool").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  $$(".brush").forEach((b) => b.addEventListener("click", () => setBrush(Number(b.dataset.level))));
  $$(".chip").forEach((b) => b.addEventListener("click", () => applyPreset(b.dataset.preset)));
  $("#btn-undo").addEventListener("click", doUndo);
  $("#btn-redo").addEventListener("click", doRedo);
  $("#btn-clear").addEventListener("click", () => { pushUndo(); S.plan.clear(); repaintAll(); });
  $("#density").addEventListener("change", (e) => { S.density = e.target.value; repaintAll(); });
  $("#text-input").addEventListener("input", () => setGhost([]));

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return;
    }
    const k = e.key.toLowerCase();
    if (k === "p") setTool("paint");
    else if (k === "r") setTool("rect");
    else if (k === "t") setTool("text");
    else if (k === "e") setTool("erase");
    else if ("1234".includes(k)) setBrush(Number(k));
  });
}

/* ────────────────────────── commit engine (browser) ────────────────────────── */
const noreplyEmail = (u) => `${u.id}+${u.login}@users.noreply.github.com`;
const safeRepoName = (n) => (n || "").trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 100) || "pixel-canvas";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isoWithOffset(dateStr, minutes) {
  const d = new Date(`${dateStr}T00:00:00`);
  const off = -d.getTimezoneOffset();
  const p = (n) => String(Math.abs(n)).padStart(2, "0");
  return `${dateStr}T${p(Math.floor(minutes / 60))}:${p(minutes % 60)}:00`
       + `${off >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

const repoReadme = (repo) => `# ${repo}

Contribution-graph art, painted with GitPixelPush.

Every commit in this repository is an intentionally **backdated, empty commit**
whose only purpose is to draw on the owner's GitHub contribution graph.
It represents no code and no work history.

Painted on ${new Date().toISOString().slice(0, 10)}.
`;

function planPayload() {
  const out = [];
  for (const date of S.plan.keys()) {
    const commits = addedCommits(date);
    if (commits > 0) out.push({ date, commits });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

async function ensureRepo(name, priv) {
  try {
    return { repo: await gh(`/repos/${S.user.login}/${name}`), existed: true };
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const repo = await gh("/user/repos", { method: "POST", body: {
    name,
    private: priv,
    description: "Contribution-graph art. Backdated empty commits, made with GitPixelPush.",
    auto_init: true, has_issues: false, has_wiki: false, has_projects: false,
  }});
  for (let i = 0; i < 10; i++) {   // wait for the auto-init commit to land
    try { await gh(`/repos/${repo.full_name}/git/ref/heads/${repo.default_branch}`); return { repo, existed: false }; }
    catch { await sleep(700); }
  }
  throw new Error("The repository was created but its first branch never appeared. Try again in a minute.");
}

/* Write with automatic recovery from GitHub's secondary rate limit:
   pause for the time GitHub asks, then pick up where we left off. */
async function ghWrite(path, opts, log) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await gh(path, opts);
    } catch (e) {
      if (e.secondary && attempt < 4) {
        const wait = (e.retryAfter || 60) + 5;
        log(`· GitHub asked us to slow down. Pausing ${wait}s, progress is safe, this resumes by itself…`);
        await sleep(wait * 1000);
      } else throw e;
    }
  }
}

async function runEngine(repoName, log, onProgress) {
  const plan = planPayload();
  const total = plan.reduce((n, p) => n + p.commits, 0);
  const author = { name: S.user.name || S.user.login, email: noreplyEmail(S.user) };

  log(`plan: ${plan.length} days, ${total} commits`);
  log(`· checking github.com/${S.user.login}/${repoName}`);
  const { repo, existed } = await ensureRepo(repoName, S.private);
  const full = repo.full_name;
  const branch = repo.default_branch || "main";
  log(existed
    ? `· repository exists (${repo.private ? "private" : "public"}), painting into it`
    : `· created ${repo.html_url} (${repo.private ? "private" : "public"})`);
  if (repo.private) log("· heads up: private pixels show only if your GitHub profile has Private contributions turned on");

  const head = await gh(`/repos/${full}/git/ref/heads/${branch}`);
  let parent = head.object.sha;
  let tree = (await gh(`/repos/${full}/git/commits/${parent}`)).tree.sha;

  if (!existed) {
    const t = await gh(`/repos/${full}/git/trees`, { method: "POST", body: {
      base_tree: tree,
      tree: [{ path: "README.md", mode: "100644", type: "blob", content: repoReadme(repoName) }],
    }});
    tree = t.sha;   // first pixel commit carries the honest README
  }

  log(`· painting ${total} commits across ${plan.length} days`);
  let done = 0, sinceCheckpoint = 0;
  for (const p of plan) {
    for (let i = 0; i < p.commits; i++) {
      if (S.abort) {
        await ghWrite(`/repos/${full}/git/refs/heads/${branch}`, { method: "PATCH", body: { sha: parent } }, log);
        log(`· stopped by you. ${done} commits are on your graph.`, "ok");
        return { repo, total: done, partial: true };
      }
      const minutes = 9 * 60 + Math.round(i * (9 * 60) / Math.max(p.commits, 1));
      const date = isoWithOffset(p.date, minutes);
      const t0 = Date.now();
      const c = await ghWrite(`/repos/${full}/git/commits`, { method: "POST", body: {
        message: `gitpixelpush: pixel ${p.date} (${i + 1}/${p.commits})`,
        tree, parents: [parent],
        author: { ...author, date }, committer: { ...author, date },
      }}, log);
      parent = c.sha;
      done++; sinceCheckpoint++;
      onProgress(done, total, p.date);
      if (sinceCheckpoint >= CHECKPOINT_EVERY) {
        await ghWrite(`/repos/${full}/git/refs/heads/${branch}`, { method: "PATCH", body: { sha: parent } }, log);
        sinceCheckpoint = 0;
        log(`· checkpoint: ${done}/${total} pushed`);
      }
      const elapsed = Date.now() - t0;
      if (elapsed < PACE_MS) await sleep(PACE_MS - elapsed);
    }
  }
  await ghWrite(`/repos/${full}/git/refs/heads/${branch}`, { method: "PATCH", body: { sha: parent } }, log);
  return { repo, total: done, partial: false };
}

/* ────────────────────────── execute modal ────────────────────────── */
function logLine(text, cls = "") {
  const log = $("#run-log");
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text + "\n";
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

function setVisibility(priv) {
  S.private = priv;
  $("#m-vis-public").classList.toggle("active", !priv);
  $("#m-vis-private").classList.toggle("active", priv);
  $("#m-private-note").hidden = !priv;
  $("#m-vis-word").textContent = priv ? "private" : "public";
  const run = $("#m-run");
  if (priv && !hasRepoScope()) {
    run.textContent = "Grant private access on GitHub";
    run.dataset.mode = "upgrade";
  } else {
    run.textContent = "I understand, push it";
    run.dataset.mode = "run";
  }
}

/* Upgrading to the repo scope means a round trip through GitHub,
   so the painted plan is parked in sessionStorage and restored after. */
function savePending() {
  sessionStorage.setItem("gpp_pending", JSON.stringify({
    plan: [...S.plan], density: S.density,
    repo: $("#m-repo-input").value, private: true,
  }));
}

function restorePending() {
  const raw = sessionStorage.getItem("gpp_pending");
  if (!raw) return;
  sessionStorage.removeItem("gpp_pending");
  try {
    const p = JSON.parse(raw);
    S.density = p.density || "auto";
    $("#density").value = S.density;
    S.plan = new Map((p.plan || []).filter(([d]) => S.byDate.has(d)));
    repaintAll();
    if (S.plan.size) {
      $("#m-repo-input").value = p.repo || "pixel-canvas";
      S.private = !!p.private;
      openExecuteModal();
    }
  } catch { /* corrupt pending state, drop it */ }
}

function refreshPreview() {
  const repo = safeRepoName($("#m-repo-input").value);
  const plan = planPayload();
  const total = plan.reduce((n, p) => n + p.commits, 0);
  $("#m-repo-url").textContent = `github.com/${S.user.login}/${repo}`;
  $("#m-commits").textContent = total.toLocaleString();
  $("#m-email").textContent = noreplyEmail(S.user);
  const p = plan[0];
  $("#m-sample").textContent =
`# one of the ${total} API calls your browser will make, verbatim:
POST /repos/${S.user.login}/${repo}/git/commits
{ "message": "gitpixelpush: pixel ${p.date} (1/${p.commits})",
  "tree": "<unchanged tree>", "parents": ["<previous commit>"],
  "author": { "name": "${S.user.name || S.user.login}",
              "email": "${noreplyEmail(S.user)}",
              "date": "${isoWithOffset(p.date, 540)}" } }`;
  gh(`/repos/${S.user.login}/${repo}`)
    .then(() => { $("#m-repo-verb").textContent = "reused"; })
    .catch(() => { $("#m-repo-verb").textContent = "created"; });
}

async function runPlan() {
  $("#modal-confirm").hidden = true;
  $("#modal-progress").hidden = false;
  $("#run-log").innerHTML = "";
  $("#m-abort").hidden = false;
  S.abort = false; S.running = true;

  const repoName = safeRepoName($("#m-repo-input").value);
  const plan = planPayload();
  const total = plan.reduce((n, p) => n + p.commits, 0);
  if (total > MAX_COMMITS) {
    logLine(`This plan needs ${total} commits; the cap is ${MAX_COMMITS} per run (GitHub's hourly API budget). Lower the ink density or paint less.`, "err");
    finishRun(); return;
  }

  try {
    const result = await runEngine(repoName, logLine, (done, tot, date) => {
      const pct = Math.round((done / tot) * 100);
      const mins = Math.ceil(((tot - done) * (PACE_MS + 150)) / 60000);
      $("#progress-fill").style.width = pct + "%";
      $("#progress-pct").textContent =
        `${pct}% · ${done}/${tot} · ${date}${done < tot ? ` · ~${mins} min left` : ""}`;
    });
    $("#progress-fill").style.width = "100%";
    if (!result.partial) logLine("✓ Pushed. GitHub can take a minute to redraw your graph.", "ok");
    $("#m-open-repo").href = result.repo.html_url;
    $("#m-open-repo").hidden = false;
    $("#m-open-profile").href = `https://github.com/${S.user.login}`;
    $("#m-open-profile").hidden = false;
    confetti();
  } catch (e) {
    logLine("✗ " + e.message, "err");
  }
  finishRun();
}

function finishRun() {
  S.running = false;
  $("#m-abort").hidden = true;
  $("#m-close").hidden = false;
}

function openExecuteModal() {
  $("#modal-confirm").hidden = false;
  $("#modal-progress").hidden = true;
  $("#m-open-repo").hidden = $("#m-open-profile").hidden = $("#m-close").hidden = true;
  $("#progress-fill").style.width = "0%";
  $("#progress-pct").textContent = "0%";
  $("#modal").hidden = false;
  setVisibility(S.private);
  refreshPreview();
}

function wireModal() {
  $("#btn-execute").addEventListener("click", openExecuteModal);
  $("#m-vis-public").addEventListener("click", () => setVisibility(false));
  $("#m-vis-private").addEventListener("click", () => setVisibility(true));
  $("#m-repo-input").addEventListener("change", refreshPreview);
  $("#m-cancel").addEventListener("click", () => { $("#modal").hidden = true; });
  $("#m-run").addEventListener("click", () => {
    if ($("#m-run").dataset.mode === "upgrade") {
      savePending();
      signIn("repo read:user");
    } else runPlan();
  });
  $("#m-abort").addEventListener("click", () => { S.abort = true; $("#m-abort").disabled = true; });
  $("#m-close").addEventListener("click", async () => {
    $("#modal").hidden = true;
    $("#m-abort").disabled = false;
    pushUndo(); S.plan.clear();
    try { buildGrid(await fetchCalendar()); } catch { repaintAll(); }
  });
  $("#modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget && !S.running) $("#modal").hidden = true;
  });
}

/* ────────────────────────── ambience & animations ────────────────────────── */
function buildPixelField() {
  const field = $("#pixel-field");
  const rng = mulberry32(7);
  for (let i = 0; i < 16; i++) {
    const px = document.createElement("i");
    const size = 6 + rng() * 9;
    px.style.cssText = `left:${rng() * 100}vw; top:${60 + rng() * 50}vh;
      width:${size}px; height:${size}px;
      background:${RAMP[Math.floor(rng() * 4)]};
      --o:${0.12 + rng() * 0.25};
      animation-duration:${20 + rng() * 22}s;
      animation-delay:-${rng() * 30}s;`;
    field.appendChild(px);
  }
}

function wireReveals() {
  if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { en.target.classList.remove("reveal-pending"); en.target.classList.add("in"); io.unobserve(en.target); }
  }, { threshold: 0.12 });
  $$(".reveal").forEach((el) => { io.observe(el); el.classList.add("reveal-pending"); });
}

function wireTilt() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  $$(".tilt, .tilt-lite").forEach((card) => {
    const max = card.classList.contains("tilt") ? 3.2 : 1.1;
    card.addEventListener("pointermove", (e) => {
      if (S.stroking || S.running) return;
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      card.style.setProperty("--ry", `${(x - 0.5) * 2 * max}deg`);
      card.style.setProperty("--rx", `${(0.5 - y) * 2 * max}deg`);
      card.style.setProperty("--mx", `${x * 100}%`);
      card.style.setProperty("--my", `${y * 100}%`);
      card.style.setProperty("--sheen", "1");
    });
    card.addEventListener("pointerleave", () => {
      card.style.setProperty("--rx", "0deg");
      card.style.setProperty("--ry", "0deg");
      card.style.setProperty("--sheen", "0");
    });
  });
}

function wireMagnetic() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  $$(".magnetic").forEach((btn) => {
    btn.addEventListener("pointermove", (e) => {
      const r = btn.getBoundingClientRect();
      const dx = (e.clientX - r.left - r.width / 2) / r.width;
      const dy = (e.clientY - r.top - r.height / 2) / r.height;
      btn.style.translate = `${dx * 6}px ${dy * 5}px`;
    });
    btn.addEventListener("pointerleave", () => { btn.style.translate = "0 0"; });
  });
}

function buildTeaser() {
  const g = $("#teaser-grid");
  const COLS = 26, cells = [];
  for (let i = 0; i < COLS * 7; i++) {
    const el = document.createElement("i");
    g.appendChild(el); cells.push(el);
  }
  const at = (c, r) => cells[c * 7 + r];
  const words = ["HI", "ART", "YOU"];
  let wi = 0;
  const rng = mulberry32(11);
  function stamp() {
    cells.forEach((el) => { el.style.background = rng() < 0.08 ? "#1b2430" : "var(--l0)"; });
    let col = Math.max(1, Math.floor((COLS - (words[wi].length * 4 - 1)) / 2));
    for (const ch of words[wi]) {
      const glyph = FONT[ch];
      for (let c = 0; c < glyph[0].length; c++)
        for (let r = 0; r < 5; r++)
          if (glyph[r][c] === "1" && at(col + c, r + 1))
            at(col + c, r + 1).style.background = RAMP[2 + Math.floor(rng() * 2)];
      col += glyph[0].length + 1;
    }
    wi = (wi + 1) % words.length;
  }
  stamp();
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) setInterval(stamp, 2800);
}

function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const rng = mulberry32(Date.now() & 0xffff);
  for (let i = 0; i < 70; i++) {
    const c = document.createElement("div");
    const size = 5 + rng() * 7;
    c.className = "confetti";
    c.style.cssText = `left:${rng() * 100}vw; width:${size}px; height:${size}px;
      background:${RAMP[Math.floor(rng() * 4)]};
      animation-duration:${1.6 + rng() * 1.6}s;
      animation-delay:${rng() * 0.5}s;`;
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 4000);
  }
}

/* ────────────────────────── views ────────────────────────── */
function enterApp(user, demo) {
  S.demo = demo; S.user = user;
  $("#landing").hidden = true;
  $("#how").hidden = true;
  $("#honest").hidden = true;
  $("#app").hidden = false;
  $("#nav-user").hidden = false;
  if (user) {
    $("#user-login").textContent = user.login;
    $("#user-avatar").src = user.avatar_url;
    $("#user-avatar").hidden = false;
  } else {
    $("#user-login").textContent = "demo";
    $("#user-avatar").hidden = true;
  }
}

async function loadReal() {
  const me = await gh("/user");
  S.user = { login: me.login, id: me.id, name: me.name || me.login, avatar_url: me.avatar_url };
  enterApp(S.user, false);
  buildGrid(await fetchCalendar());
  restorePending();
}

/* ────────────────────────── init ────────────────────────── */
(async function init() {
  buildPixelField(); buildTeaser(); wireReveals(); wireTilt(); wireMagnetic();
  wireGrid(); wireToolbar(); wireModal();
  setTool("paint"); setBrush(3);

  $("#btn-demo").addEventListener("click", () => { enterApp(null, true); buildGrid(demoCalendar()); });
  $("#btn-signout").addEventListener("click", signOut);

  if (!configured()) {
    $("#setup-note").textContent = "Sign-in is temporarily unavailable because this deployment is not configured.";
    $("#setup-note").hidden = false;
    $("#btn-signin").disabled = true;
  } else {
    $("#btn-signin").addEventListener("click", () => signIn());
  }

  try {
    if (await handleOAuthRedirect()) { await loadReal(); return; }
    if (token()) { await loadReal(); return; }
  } catch (e) {
    authError("Could not load your GitHub data: " + e.message);
  }
  if (location.hash === "#demo") { enterApp(null, true); buildGrid(demoCalendar()); }
})();
