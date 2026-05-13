# Using Constellar

A walkthrough from "I just cloned this" to "I have an AI curator scoring my feed and a constellation map of my interests." No prior context assumed.

---

## 1. What Constellar is

Constellar is a personal feed reader. It pulls items from RSS feeds and Reddit, dedupes them, and shows them in two views:

- **List view** — a scrollable, editorial-style feed.
- **Constellation view** — a star-map where similar items cluster together.

You can run it without ever touching an API key. The basic fetch + list works on its own. The AI layer (item scoring, takes, cluster names, taste-profile learning) is opt-in and bolts on top once you provide an Anthropic key.

---

## 2. First-time setup (no API keys yet)

### 2.1. Install

From the repo root:

```powershell
python -m venv .venv
. .venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### 2.2. Launch

```powershell
python app.py            # default: native window (PyWebView) if available
python app.py --web      # browser mode — open http://127.0.0.1:5173
python app.py --tray     # background, with a system-tray icon
```

For day-to-day use, `pyw app.py --tray` is the smoothest: no console, parked icon, click to open.

### 2.3. Pull your first batch

Constellar auto-refreshes on launch when your data is older than 30 minutes (or the DB is empty). The first refresh downloads a small embedding model (≈30 seconds on a fresh install) and then fetches every source in `data/sources.json` in parallel. After it finishes, the list view fills. If you want to pull again sooner, hit the **refresh** button in the top bar.

You can already:

- **Click** a card → opens the link, marks it clicked.
- **Dismiss** a card (the × or `Delete`/`Backspace`) → soft-hide; reversible with the **undo** button in the header.
- **Reject** a card → strong negative signal (this matters later, once the AI is on).
- Toggle to **constellation** view in the top bar. Even before you add an API key, stars are colour-coded by source and clusters get auto-named from a curated palette — the AI layer (section 4) adds per-item takes and tonally-precise cluster naming on top.

That's the floor. From here, everything is configuration or AI on top.

---

## 3. Configuring which feeds you want

All sources live in `data/sources.json`. Two top-level keys: `rss` and `reddit`.

### 3.1. RSS feeds

Each entry is an object:

```json
{
  "name": "wired",
  "url": "https://www.wired.com/feed/rss",
  "tags": ["wired", "tech", "science", "longform"]
}
```

- `name` — short slug; shows up on cards and is used for colours.
- `url` — any RSS or Atom feed.
- `tags` — auto-applied to every item from this source. The curator and classifier both lean on these, so be honest and specific (`la-local`, `youth-culture`, `longform`) rather than generic (`stuff`, `news`).

To **add** a source: drop another object into the `rss` array. To **remove** one: delete its object. To **tweak** what tags get auto-applied: edit its `tags` list. Changes take effect on the next refresh — no restart needed.

### 3.2. Reddit

The `reddit` block has three parts.

**`credentials`** — leave empty to use Reddit's public `.rss` endpoints (capped at ~25 items per sub, no vote counts). Fill `client_id` + `client_secret` to unlock the full PRAW path (configurable sort modes, real score and comment counts, higher limits). See section 4.2 for how to get those.

**`frontpage`** — pull r/popular (or your personalised frontpage if you also supplied `username` + `password`):

```json
"frontpage": { "enabled": true, "sort": "hot", "limit": 100 }
```

**`subreddits`** — a list of subreddit configs:

```json
{ "name": "indieheads", "sort": "hot", "limit": 25,
  "tags": ["music", "indie", "discussion"] }
```

- `name` — without the `r/` prefix.
- `sort` — one of `hot`, `new`, `top`, `rising`.
- `limit` — how many to pull per refresh.
- `tags` — auto-applied, same as RSS.

To **add** a sub: append another entry. To **remove** one: delete its entry. To **change sort or volume**: edit `sort` / `limit`.

### 3.3. Tip: start narrow

The defaults in the repo pull ≈600 items per refresh across a wide spread. That's a lot of noise before the AI is trained. Trim `data/sources.json` down to the ~10 subs and feeds you actually care about while you're getting started — you can always re-add the firehose later.

---

## 4. Turning on the AI layer

Everything above runs with zero API keys. This section is what unlocks per-item takes, cluster names, the classifier, and the taste-profile loop.

### 4.1. The config file

Constellar reads secrets from `~/.constellar/config.env` (i.e. `C:\Users\<you>\.constellar\config.env`). The file lives outside the repo so it can't be committed by accident.

**Create it once:**

```powershell
mkdir $HOME\.constellar
copy config.env.example $HOME\.constellar\config.env
notepad $HOME\.constellar\config.env
```

The template lists every key. Leave anything you don't use blank.

### 4.2. Step-by-step: get the keys

**Anthropic key** (required for any AI feature):

1. Go to <https://console.anthropic.com/settings/keys>.
2. Click "Create Key", name it something like `constellar`, copy the value.
3. Paste into `config.env`: `ANTHROPIC_API_KEY=sk-ant-...`.

**Reddit credentials** (optional — only needed if you want better Reddit results than the public RSS fallback):

1. Go to <https://www.reddit.com/prefs/apps>.
2. Click "create another app…" at the bottom.
3. Pick **script** as the type.
4. Name it (e.g. `constellar`), put `http://localhost` for the redirect URI, save.
5. The string under "personal use script" is your `REDDIT_CLIENT_ID`. The "secret" field is `REDDIT_CLIENT_SECRET`.
6. Paste both into `config.env`.

**Reddit user auth** (further optional — only needed for *your personalised* frontpage, not r/popular):

- Set `REDDIT_USERNAME` and `REDDIT_PASSWORD` in `config.env`.
- Caveat: this disables 2FA on Constellar's auth. Use an app password if you have 2FA on your Reddit account, or skip this section.

### 4.3. Restart the app

`config.env` is read once at startup. Close Constellar and re-launch:

```powershell
python app.py --tray
```

You should see `[constellar] loaded N secrets from ...config.env` in the log (in tray mode, that's `~/.constellar/constellar.log`).

### 4.4. First curated refresh

Hit refresh. With an Anthropic key present, the refresh now runs additional stages after fetching:

1. **Embed** new items (local model, no API call).
2. **Classify** them with your local classifier (skipped until you have ≥25 clicks and ≥25 rejects — cold-start is permissive).
3. **Curate** with Claude Haiku in batches of 20.
4. **Project** into 2D for the constellation view.
5. **Cluster** + **name** the resulting clusters.

The list view re-sorts by AI score, top items get a featured-card treatment with the take rendered as a pull-quote, and stars on the constellation pick up colours and named labels.

---

## 5. What the AI actually does

Each piece is small and replaceable. Knowing what's running where makes it obvious what changes when, and what you can ignore.

### 5.1. The curator (`backend/curator.py`)

For every new item, Claude Haiku returns three things:

- **`relevance`** — float 0.0–1.0. Drives the default sort and the size of the star on the map.
- **`comment`** — one short, opinionated line. Appears as the take on the card and in the constellation hover panel.
- **`tags`** — 1–3 topic tags, added on top of the source tags. These build up a taxonomy across your feed over time.

The system prompt + your taste profile are prompt-cached, so the marginal cost per refresh is small. The log line `[curator] batch=20 in=... cache_r=... cache_w=... out=...` is the receipt.

### 5.2. The taste profile (`data/preferences.md`)

This file is the AI's memory of what you like. It's regenerated, not appended.

- Built by `backend/distill.py` using Claude Sonnet — a once-a-day pattern-spotting pass over your recent clicks and rejects.
- Trigger it manually with `POST /api/distill` (e.g. `curl -X POST http://127.0.0.1:5173/api/distill`).
- The file stays under ~1500 words so it caches cheaply when the curator reads it on every batch.
- A `## User-locked notes` section is preserved verbatim — that's where you can hand-pin durable preferences ("never surface celebrity gossip", "always show Aeon longreads") that survive future distillations.

What changes when this file exists: the curator scores aggressively against it. Your `relevance` numbers stop being a generic "is this interesting?" and become "does this match *this user's* taste right now?"

### 5.3. The classifier (`backend/classifier.py`)

A local scikit-learn logistic regression on top of your item embeddings. Trains from your clicks (positive) and rejects (negative). No API calls.

- Below 25 clicks **and** 25 rejects, it doesn't train — every item gets a permissive default score (0.7) and the curator sees everything.
- Past that threshold, it acts as a cheap bouncer: low-scoring items can be skipped before they reach Claude, saving tokens.
- Retrained from scratch on each refresh — fast at this scale.

What changes when this kicks in: refreshes get cheaper as your feed scales, and the AI quietly sharpens around your patterns without an API round-trip per item.

### 5.4. Cluster naming (`backend/distill.py::name_clusters`)

The constellation view groups items into clusters. Every refresh, projection re-runs HDBSCAN and wipes the cluster table — naming then re-assigns labels so the constellation never gets stuck on `cluster 12 · 8` style placeholders.

With an Anthropic key, Claude Haiku picks a name for each cluster from a curated palette in `backend/constellation_names.md`, matched to the cluster's mood (Soft & Sibilant, Hard-Edged & Gothic, etc.).

Without an API key, the same palette is used but assignment is deterministic round-robin — you still get named constellations, just less tonally on-point.

Beneath each cluster name, a small italic subtitle in parentheses lists the cluster's top three tags (e.g. `(gaming, video-games, console-wars)`). Tags come from both the source-tag list in `data/sources.json` and the AI-suggested tags from per-item curation, ranked by frequency within the cluster. Tune with `_CLUSTER_TAG_TOP_N` near the top of `frontend/constellation.js`.

### 5.5. What stays local vs. what hits the API

| Step               | Local | Claude (paid) | Reddit API |
|--------------------|:-----:|:-------------:|:----------:|
| Fetch RSS          | yes   |               |            |
| Fetch Reddit       | yes   |               | yes        |
| Dedupe + store     | yes   |               |            |
| Embeddings         | yes   |               |            |
| Classifier         | yes   |               |            |
| Per-item curation  |       | Haiku         |            |
| Taste profile      |       | Sonnet (1×/day) |          |
| Cluster names      |       | Haiku         |            |
| 2D projection      | yes   |               |            |

Item text, titles, and URLs are sent to Anthropic only when the curator runs. If you delete `ANTHROPIC_API_KEY`, the whole AI column goes dark and the app degrades to the basic fetch + list view from section 2.

---

## 6. Reading the constellation view

Each item is a star. The visual encoding is consistent and worth knowing:

- **Position** — set by UMAP on the embedding. Nearby stars are about similar things; distant ones aren't. Clusters form naturally from this.
- **Colour** — the source (kotaku green, gizmodo orange, reddit-style orange-red for subs, etc.).
- **Cluster label** — the named group the star belongs to (Section 5.4), with a smaller italic `(tag, tag, tag)` subtitle showing the cluster's dominant topics. Hidden until you zoom out enough that labels stop overlapping their stars.
- **White dwarfs** — dismissed items render as small, desaturated bloom-only stars. They linger on the map for 90 days then auto-purge.

### Star size (glow)

Three rules, picked per item:

- **Reddit with a real upvote count** (PRAW credentials configured): linear by votes, normalised against the highest-scoring item currently loaded. A massively-upvoted post hits the 2.5× cap; everything else scales between.
- **Anything with a real `published_at`** (most RSS news, HN, Reddit RSS fallback when the feed includes pubDate): scaled by absolute wall-clock age along a piecewise-linear curve. Control points: `≤2h → largest`, `8h → 70%`, `25h → 25%`, `≥48h → smallest`. Linearly interpolated between, clamped flat at the ends. The dropoff is steep on purpose — fresh news stays visibly bigger than day-old.
- **No `published_at` at all** (rare — feeds that omit pubDate entirely): scaled by *ordinal position within that source* along its own curve. Control points: `first 10% of the source's items → largest`, `25% → 70%`, `50% → 25%`, `100% → smallest`. The newest-fetched item from that source sits at position 0 and so renders biggest.

All three share the same 1×–2.5× range so a freshly-posted news item and a heavily-upvoted Reddit post look comparably prominent. Because the time curve uses wall-clock now (not corpus range), an RSS item shrinks naturally as it ages even without a refresh — leave Constellar open overnight and yesterday's news drifts down.

To retune: `_RECENCY_CURVE` (time-based) and `_ORDINAL_CURVE` (no-timestamp fallback) both live near the top of `frontend/constellation.js`. Both are fed into the same `_interpCurve(x, curve)` interpolator, so editing one of the tables is enough — no formula changes needed.

If you start without PRAW credentials and later add them, your Reddit items quietly switch from recency-sized to vote-sized on the next refresh. No reset needed.

## 7. Daily-driver cheat sheet

- **Refresh**: happens automatically on launch when data is more than 30 minutes stale. Manual: top-right button, or click the tray icon → Open. Concurrent refreshes are de-duplicated server-side, so clicking the button while auto-refresh is mid-flight is a safe no-op.
- **Open a card**: click, or Enter when focused.
- **Hide a card** (reversible): dismiss button, or `Backspace` / `Delete`.
- **Strong "no"** (trains the model): reject (× icon, or `Shift+Right-click` in constellation view).
- **Undo the last dismiss**: undo button in the header.
- **Rebuild taste profile**: `curl -X POST http://127.0.0.1:5173/api/distill`.
- **Re-name clusters**: `curl -X POST http://127.0.0.1:5173/api/name-clusters`.
- **Logs** (tray mode, no console): `~/.constellar/constellar.log`.
- **All your data**: `data/feed.db`, `data/clicks.jsonl`, `data/rejects.jsonl`, `data/preferences.md`. All gitignored. Deleting `feed.db` resets the feed; deleting `preferences.md` resets the AI's memory of you.
