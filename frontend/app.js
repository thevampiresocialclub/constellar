// Constellar — list view, view switching, refresh + curate, toasts.
//
// Lessons baked in:
//   - SSE-streamed refresh shows real progress (first run downloads model)
//   - Failed network calls surface as toasts (no silent loss)
//   - Cards are keyboard navigable (Enter to open, Backspace/Delete to dismiss)
//   - Stats line is collapsed by default; full debug breakdown on hover
//   - Editorial list view: top items get featured treatment with pull-quote
//   - Source colors map to explicit palette where defined

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- text-size control ----------
// Scales text-bearing rules across list view AND constellation view (panels,
// status, overlay, cluster labels) via the CSS custom property --text-scale.
// Canvas mouse coordinates stay correct because canvas dimensions don't
// depend on the variable — only the rendered font sizes inside it do.
// Default 1.3 ≈ +4pt vs. the natural 14px base. Range and step were widened
// so each click is visibly bigger than a 7%-per-tick noise.
const SCALE_DEFAULT = 1.30;
const SCALE_MIN = 0.80;
const SCALE_MAX = 2.20;
const SCALE_STEP = 0.15;

let textScale = parseFloat(localStorage.getItem("constellar.text-scale") || SCALE_DEFAULT);
if (!isFinite(textScale)) textScale = SCALE_DEFAULT;
applyTextScale();

function applyTextScale() {
  textScale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, textScale));
  document.documentElement.style.setProperty("--text-scale", String(textScale));
  localStorage.setItem("constellar.text-scale", String(textScale));
}

// Mirror of the explicit colors in constellation.js / styles.css.
const SOURCE_COLORS = {
  "kotaku":    "#a8ff00",
  "gizmodo":   "#ff6f3c",
  "the-face":  "#f5f5f5",
  "laist":     "#ffb84d",
  "frontpage": "#ff4500",
  "reddit":    "#ff4500",
};
function colorForSource(name) {
  if (!name) return "#9aa";
  if (name.startsWith("r/")) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return `hsl(${5 + (Math.abs(h) % 40)}, 80%, 60%)`;
  }
  if (SOURCE_COLORS[name]) return SOURCE_COLORS[name];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 70%, 65%)`;
}

const feed = $("#list-view");
const refreshBtn = $("#refresh");
const refreshLabel = $("#refresh-label");
const refreshBar = $("#refresh-bar");
const statsEl = $("#stats");
const statsDetail = $("#stats-detail");
const toastEl = $("#toast");

// ---------- toast (also exposed as window.toast for constellation.js) ----------
let toastTimer = null;
function toast(msg, opts = {}) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  toastEl.classList.toggle("error", !!opts.error);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, opts.long ? 4000 : 2500);
}
window.toast = toast;

// ---------- undo last dismissal (single-slot, session-only) ----------
// Both the list view and the constellation view feed into this. The undo
// button in the header is hidden until something is dismissed; pressing it
// flips the most-recently-dismissed item back to 'new' on the server and
// reloads whichever view(s) are live.
const undoBtn = $("#undo-dismiss");
let lastDismissedId = null;

function recordDismissal(id) {
  lastDismissedId = id;
  if (undoBtn) {
    undoBtn.disabled = false;
    undoBtn.title = "Undo last dismissal";
  }
}
function clearUndo() {
  lastDismissedId = null;
  if (undoBtn) {
    undoBtn.disabled = true;
    undoBtn.title = "Undo last dismissal (becomes available after you dismiss something)";
  }
}
window.recordDismissal = recordDismissal;
window.clearUndo = clearUndo;

function relTime(iso) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const diff = (Date.now() - then) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function primaryTagText(item) {
  if (item.source_kind === "reddit") {
    return item.source_name === "frontpage" ? "frontpage" : `r/${item.source_name}`;
  }
  return item.source_name || "unknown";
}

function tagEl(tag, kind) {
  const t = document.createElement("span");
  let cls = "tag";
  if (kind === "source") {
    cls += " source";
    t.style.setProperty("--tag-color", colorForSource(tag));
  }
  t.className = cls;
  t.textContent = tag;
  return t;
}

// ---------- card (editorial: featured vs standard) ----------
function cardEl(item, opts = {}) {
  const featured = !!opts.featured;
  const card = document.createElement("article");
  card.className = "card" + (featured ? " card-featured" : "");
  card.dataset.id = item.id;
  card.tabIndex = 0; // keyboard-focusable

  const top = document.createElement("div");
  top.className = "top";
  const sourceText = primaryTagText(item);
  top.appendChild(tagEl(sourceText, "source"));
  const seenTags = new Set([sourceText, "reddit"]);
  for (const t of (item.tags || [])) {
    if (seenTags.has(t)) continue;
    seenTags.add(t);
    top.appendChild(tagEl(t, "topic"));
  }
  card.appendChild(top);

  const h = document.createElement("h2");
  h.className = "card-title";
  const link = document.createElement("a");
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = item.title;
  link.addEventListener("click", () => clickItem(item.id));
  h.appendChild(link);
  card.appendChild(h);

  // AI commentary takes precedence over the raw snippet.
  // Featured cards get a pull-quote treatment; standard ones a callout line.
  if (item.ai_comment) {
    const c = document.createElement("p");
    c.className = featured ? "ai-quote" : "ai-comment";
    c.textContent = featured ? `"${item.ai_comment}"` : item.ai_comment;
    card.appendChild(c);
  } else if (item.snippet) {
    const s = document.createElement("p");
    s.className = "snippet";
    s.textContent = item.snippet;
    card.appendChild(s);
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = relTime(item.published_at || item.fetched_at);
  meta.appendChild(when);

  if (item.author) {
    const a = document.createElement("span");
    a.className = "author";
    a.textContent = `· ${item.author}`;
    meta.appendChild(a);
  }

  if (typeof item.ai_score === "number") {
    const score = document.createElement("span");
    score.className = "score";
    score.textContent = `· ${(item.ai_score * 100).toFixed(0)}`;
    score.title = `AI relevance score: ${item.ai_score.toFixed(2)}`;
    meta.appendChild(score);
  }

  const spacer = document.createElement("span");
  spacer.className = "spacer";
  meta.appendChild(spacer);

  // Dismiss (X) — soft hide, no ML signal. Default keyboard action.
  const dismiss = document.createElement("button");
  dismiss.className = "icon-btn dismiss";
  dismiss.setAttribute("aria-label", `Dismiss "${item.title}"`);
  dismiss.title = "Dismiss (or press Backspace) — no ML signal";
  dismiss.textContent = "✕";
  dismiss.addEventListener("click", (e) => {
    e.stopPropagation();
    dismissItem(item.id, card);
  });
  meta.appendChild(dismiss);

  // Reject (⊘) — heavy negative signal for the classifier.
  const reject = document.createElement("button");
  reject.className = "icon-btn reject";
  reject.setAttribute("aria-label", `Reject "${item.title}"`);
  reject.title = "Reject (or press Shift+Backspace) — strong negative signal";
  reject.textContent = "⊘";
  reject.addEventListener("click", (e) => {
    e.stopPropagation();
    rejectItem(item.id, card);
  });
  meta.appendChild(reject);

  card.appendChild(meta);

  // Keyboard nav: Enter opens, Backspace/Delete dismisses, Shift+ either rejects.
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clickItem(item.id);
      window.open(item.url, "_blank", "noopener,noreferrer");
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      if (e.shiftKey) rejectItem(item.id, card);
      else dismissItem(item.id, card);
    }
  });

  return card;
}

// ---------- source dividers ----------
function dividerEl(label, count) {
  const d = document.createElement("div");
  d.className = "divider";
  d.style.setProperty("--tag-color", colorForSource(label));
  const lbl = document.createElement("span");
  lbl.className = "divider-label";
  lbl.textContent = label;
  const c = document.createElement("span");
  c.className = "divider-count";
  c.textContent = count + (count === 1 ? " item" : " items");
  d.appendChild(lbl);
  d.appendChild(c);
  return d;
}

// ---------- list rendering ----------
async function loadItems() {
  try {
    const [itemsRes, statsRes] = await Promise.all([
      fetch("/api/items?status=new&limit=300"),
      fetch("/api/stats"),
    ]);
    const { items } = await itemsRes.json();
    const stats = await statsRes.json();

    // Stats: collapsed = "N new" (or "N waiting · K curated" if any AI work has happened).
    const newCount = stats.by_status?.new ?? 0;
    const curated = stats.curated ?? 0;
    statsEl.textContent = curated > 0
      ? `${newCount} waiting · ${curated} curated`
      : `${newCount} waiting`;

    // Detail (revealed via tooltip)
    const detail = [
      `total: ${stats.total}`,
      `embedded: ${stats.embedded ?? 0}`,
      `mapped: ${stats.projected ?? 0}`,
      `curated: ${stats.curated ?? 0}`,
      stats.classifier?.trained
        ? `classifier: ${stats.classifier.n_pos}+/${stats.classifier.n_neg}-`
        : "classifier: cold-start (let-through)",
    ];
    if (statsDetail) statsDetail.textContent = detail.join(" · ");
    statsEl.title = detail.join("\n");

    feed.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "the feed is empty. press refresh to summon some.";
      feed.appendChild(empty);
      return;
    }

    // Sort: AI score desc, then recency.
    items.sort((a, b) => {
      const sa = typeof a.ai_score === "number" ? a.ai_score : -1;
      const sb = typeof b.ai_score === "number" ? b.ai_score : -1;
      if (sa !== sb) return sb - sa;
      const ta = new Date(a.published_at || a.fetched_at).getTime();
      const tb = new Date(b.published_at || b.fetched_at).getTime();
      return tb - ta;
    });

    // Editorial: first 3 by score with ai_score >= 0.7 are "featured"
    let featuredCount = 0;
    for (const item of items) {
      if (featuredCount < 3 && typeof item.ai_score === "number" && item.ai_score >= 0.7) {
        feed.appendChild(cardEl(item, { featured: true }));
        featuredCount++;
      } else {
        feed.appendChild(cardEl(item));
      }
    }
  } catch (err) {
    toast(`load failed: ${err.message}`, { error: true });
  }
}

function clickItem(id) {
  fetch(`/api/items/${id}/click`, { method: "POST" })
    .catch(() => toast("click logging failed", { error: true }));
}

async function dismissItem(id, card) {
  await _fadeOutCard(id, card, "dismiss");
}

async function rejectItem(id, card) {
  await _fadeOutCard(id, card, "reject");
}

async function _fadeOutCard(id, card, action) {
  card.classList.add("removing");
  try {
    const res = await fetch(`/api/items/${id}/${action}`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setTimeout(() => card.remove(), 250);
    if (action === "dismiss") recordDismissal(id);
  } catch (err) {
    card.classList.remove("removing");
    toast(`${action} failed: ${err.message}`, { error: true });
  }
}

// ---------- SSE-streamed refresh ----------
function setRefreshProgress(label, progress01) {
  if (refreshLabel) refreshLabel.textContent = label;
  if (refreshBar) refreshBar.style.width = `${Math.round(progress01 * 100)}%`;
}

const STAGE_ORDER = ["fetch", "embed", "project", "score", "curate", "name_clusters", "done"];
const STAGE_LABELS = {
  fetch:         "fetching sources…",
  embed:         "embedding new items…",
  project:       "mapping to constellation…",
  score:         "scoring with classifier…",
  curate:        "asking Claude…",
  name_clusters: "naming clusters…",
  done:          "done",
};

// Shared by the manual button AND the auto-refresh-on-launch flow.
// `silent: true` suppresses the success toast — auto-refresh shouldn't yell
// "refresh complete" the moment you open the app.
let _refreshInFlight = false;
function runRefresh({ silent = false } = {}) {
  if (_refreshInFlight) return;
  _refreshInFlight = true;
  refreshBtn.disabled = true;
  setRefreshProgress("starting…", 0.05);

  const totalStages = STAGE_ORDER.length - 1; // exclude "done"
  let completedStages = 0;
  let lastError = null;
  let serverSkipped = false;

  const es = new EventSource("/api/refresh/stream?curate=true");

  es.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }

    if (data.stage === "busy" || data.skipped) {
      // Server says another refresh is already running. Close cleanly; we'll
      // pick up the new items from /api/items once the other run finishes.
      serverSkipped = true;
    }

    if (data.stage === "done") {
      es.close();
      finalize(lastError);
      return;
    }

    const label = STAGE_LABELS[data.stage] || data.stage;
    if (data.status === "start") {
      const progress = (completedStages + 0.5) / totalStages;
      setRefreshProgress(label, progress);
    } else if (data.status === "done" || data.status === "skipped") {
      completedStages++;
      const progress = completedStages / totalStages;
      setRefreshProgress(label, progress);
    } else if (data.status === "error") {
      lastError = `${data.stage}: ${data.error?.slice(0, 100) || "error"}`;
      completedStages++;
      setRefreshProgress(`${label} failed`, completedStages / totalStages);
    }
  };

  es.onerror = () => {
    es.close();
    finalize("connection lost");
  };

  function finalize(err) {
    setRefreshProgress("", 0);
    refreshBtn.disabled = false;
    _refreshInFlight = false;
    if (err) toast(`refresh: ${err}`, { error: true, long: true });
    else if (!silent && !serverSkipped) toast("refresh complete");
    loadItems();
    if (currentView === "constellation") Constellation.load();
  }
}

refreshBtn.addEventListener("click", () => runRefresh());

// ---------- auto-refresh on launch ----------
// Triggers the same SSE refresh the button does, but only when the data is
// stale (newest fetched_at is more than this many minutes old) or the DB is
// empty. Avoids hammering Reddit/Anthropic on every page reload while still
// keeping the feed fresh when you open the app after a few hours.
const AUTO_REFRESH_STALENESS_MIN = 30;
async function maybeAutoRefresh() {
  try {
    const res = await fetch("/api/stats");
    if (!res.ok) return;
    const stats = await res.json();
    const newest = stats.newest_fetched_at;
    const stale =
      !newest ||
      (Date.now() - new Date(newest).getTime()) > AUTO_REFRESH_STALENESS_MIN * 60 * 1000;
    if (stale) runRefresh({ silent: true });
  } catch {
    // Network blip on startup shouldn't block the UI. The user can still hit
    // the refresh button manually.
  }
}

// ---------- view switching ----------
let currentView = "list";
let constellationInited = false;

function switchView(name) {
  if (name === currentView) return;
  currentView = name;
  $$(".view").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("#list-view").hidden = name !== "list";
  $("#constellation-view").hidden = name !== "constellation";

  if (name === "constellation") {
    if (!constellationInited) {
      Constellation.init(
        $("#constellation-canvas"),
        $("#constellation-panel"),
        $("#constellation-status"),
        $("#constellation-overlay"),
        $("#constellation-overlay-close"),
      );
      constellationInited = true;
    }
    Constellation.load();
  }
}

$$(".view").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!btn.disabled) switchView(btn.dataset.view);
  });
});

// ---------- text-size buttons ----------
// Toasts the new size on every click so it's obvious whether the click
// registered (and reveals when you've hit the min/max cap).
function changeFontSize(delta) {
  const before = textScale;
  textScale += delta;
  applyTextScale();   // clamps + persists
  const pct = Math.round(textScale * 100);
  if (textScale === before) {
    toast(`text size: ${pct}% (${delta > 0 ? "max" : "min"})`);
  } else {
    toast(`text size: ${pct}%`);
  }
}
$("#font-up")  .addEventListener("click", () => changeFontSize(SCALE_STEP));
$("#font-down").addEventListener("click", () => changeFontSize(-SCALE_STEP));

// ---------- undo button ----------
if (undoBtn) {
  undoBtn.addEventListener("click", async () => {
    if (!lastDismissedId) return;
    const id = lastDismissedId;
    try {
      const res = await fetch(`/api/items/${id}/undismiss`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      clearUndo();
      toast("dismissal undone");
      loadItems();
      // Refresh constellation too if it's been initialized — the dismissed
      // item's status needs to flip back to 'new' there as well.
      if (constellationInited && window.Constellation) Constellation.load();
    } catch (err) {
      toast(`undo failed: ${err.message}`, { error: true });
    }
  });
}

loadItems();
maybeAutoRefresh();
