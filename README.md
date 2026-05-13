# Constellar

A personal news + Reddit reader that treats your feed as a **map of ideas**, not a vertical list.

Every item is fetched, embedded as a vector, and projected into 2D — so similar stories cluster together in space. You see the same data two ways: a familiar editorial list, and a star-field constellation where topics emerge before any single feed flags them.

A cloud AI curator (Claude) scores each item, writes a one-line take, and suggests tags. A local machine-learning classifier learns from your clicks and rejects. Without an API key you still get fetch, dedupe, a coloured constellation, and offline-named clusters.

---

## Quick start

```powershell
python -m venv .venv
. .venv\Scripts\Activate.ps1
pip install -r requirements.txt

pyw app.py --tray        # background, parked in the system tray
```

Auto-refresh fires on launch when your data is more than 30 minutes stale. The first refresh downloads a small embedding model (~30s) and pulls every source in `data/sources.json` in parallel. After that, refreshes are seconds.

Full setup walkthrough — including how to wire up the Anthropic key and Reddit credentials — in **[INSTRUCTIONS.md](./INSTRUCTIONS.md)**.

---

## What's inside

- **Dual view.** A scrollable editorial list with featured cards + AI takes, and a pan/zoom constellation where stars are positioned by topical similarity, sized by recency or upvotes, and grouped into named clusters.
- **Local-first ML.** Embeddings (fastembed / ONNX, no GPU), UMAP projection, HDBSCAN clustering, and a scikit-learn classifier — all on your machine.
- **Cloud-augmented.** Optional Claude Haiku curator with prompt caching, Claude Sonnet for the once-a-day taste-profile distillation, Claude Haiku again for tonally-precise cluster naming.
- **Learns you.** Clicks become positive labels, rejects become negative. A daily distillation pass rewrites `preferences.md` so the curator stays calibrated to your taste.
- **Runs cold.** No API key required for fetch, dedupe, constellation, or offline cluster naming. Add a key and the AI layer turns on transparently.
- **Native window or tray.** PyWebView for a desktop window, `pystray` for a system-tray icon, or just open `http://127.0.0.1:5173` in any browser.

---

## Repo layout

```
app.py                          launcher (PyWebView / tray / web)
backend/
  main.py                       FastAPI routes
  fetch_runner.py               pipeline orchestrator
  fetchers/{rss,reddit}.py      source fetchers
  embeddings.py                 fastembed wrapper
  projection.py                 UMAP + HDBSCAN
  classifier.py                 scikit-learn LogReg
  curator.py                    Claude Haiku per-item scoring
  distill.py                    preferences.md + cluster naming
  db.py                         SQLite schema + queries
  constellation_names.md        curated naming palette
frontend/
  index.html · app.js · constellation.js · styles.css
data/
  sources.json                  edit this to choose your feeds
  feed.db, clicks.jsonl, …      generated at runtime (gitignored)
config.env.example              template for ~/.constellar/config.env
Constellar.vbs                  Windows launcher
Setup-Shortcuts.vbs             desktop + Start Menu shortcut installer
INSTRUCTIONS.md                 full setup + operation guide
Constellar.pptx                 8-slide showcase deck
Constellar-pitch.pptx           single-slide elevator pitch
generate_deck.py                regenerates the deck
generate_pitch.py               regenerates the pitch
```

---

## Stack

FastAPI · SQLite · fastembed (ONNX) · UMAP · HDBSCAN · scikit-learn · Anthropic SDK · vanilla JS / Canvas2D. No GPU, no build step, no service mesh.

---

## License

MIT — see `LICENSE`. (Or whichever license you'd like to use; this repo doesn't ship one yet — add one before pushing if it matters to you.)
