"""FastAPI backend: serves the frontend and exposes feed CRUD."""

from __future__ import annotations

import json
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from . import db
from .fetch_runner import refresh_all

# Guards /api/refresh and /api/refresh/stream so concurrent callers don't
# double-fetch from the same sources. Acquired non-blocking — second caller
# bails immediately with a single 'busy' event rather than waiting in line.
# Used by the frontend's auto-refresh-on-launch: a manual refresh in tab A
# while tab B is auto-refreshing should be a no-op, not a duplicate run.
_refresh_lock = threading.Lock()

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"
DATA_DIR = ROOT / "data"
CLICKS_LOG = DATA_DIR / "clicks.jsonl"
REJECTS_LOG = DATA_DIR / "rejects.jsonl"
DISMISSES_LOG = DATA_DIR / "dismisses.jsonl"

# Dismissed items linger as "white dwarfs" on the constellation but are dropped
# after this window so the graveyard doesn't grow forever.
DISMISS_TTL_DAYS = 90

# Logs rotate when they exceed this; older content is moved to *.1, *.2.
MAX_LOG_BYTES = 4 * 1024 * 1024
KEEP_ROTATIONS = 3

# Hosts that are allowed to make state-changing requests. Localhost binding
# alone does NOT prevent CSRF — any open browser tab on a malicious site can
# fetch() to localhost. We guard mutating routes by checking the Origin header.
ALLOWED_ORIGINS = {
    "http://127.0.0.1:5173",
    "http://localhost:5173",
}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class OriginGuard(BaseHTTPMiddleware):
    """Reject mutating cross-origin requests. Skips same-origin and tools that
    don't send an Origin header (PyWebView, curl from terminal)."""

    async def dispatch(self, request: Request, call_next):
        if request.method not in SAFE_METHODS:
            origin = request.headers.get("origin")
            if origin and origin not in ALLOWED_ORIGINS:
                from fastapi.responses import JSONResponse
                return JSONResponse(
                    {"detail": f"origin not allowed: {origin}"},
                    status_code=403,
                )
        return await call_next(request)


class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    """Force the WebView2 / browser to revalidate index.html and static assets
    on every load. Without this, edits to frontend/*.js / *.css don't appear
    until the user manually clears the cache or the WebView2 storage gets
    blown away. Only applies to / and /static/* — API responses are untouched."""

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path == "/" or path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response


app = FastAPI(title="Constellar")
app.add_middleware(OriginGuard)
app.add_middleware(NoCacheStaticMiddleware)


@app.on_event("startup")
def _startup():
    db.init_db()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    purged = db.purge_old_dismissed(DISMISS_TTL_DAYS)
    if purged:
        import sys
        print(f"[constellar] purged {purged} dismissed items older than "
              f"{DISMISS_TTL_DAYS} days", file=sys.stderr)


@app.get("/api/items")
def get_items(status: str | None = "new", limit: int = 200):
    if status == "all":
        status = None
    return {"items": db.list_items(status=status, limit=limit)}


@app.get("/api/stats")
def get_stats():
    base = db.stats()
    try:
        from .classifier import classifier_status
        base["classifier"] = classifier_status()
    except Exception:
        pass
    return base


@app.post("/api/refresh")
def post_refresh(curate: bool = False):
    if not _refresh_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "a refresh is already running"}
    try:
        return refresh_all(do_curate=curate)
    finally:
        _refresh_lock.release()


@app.get("/api/refresh/stream")
def get_refresh_stream(curate: bool = True):
    """SSE-streamed refresh. Frontend opens this with EventSource so the user
    sees stage-by-stage progress (esp. important on first run, which downloads
    the embedding model and can take 30+ seconds)."""
    from .fetch_runner import refresh_all_streaming

    def event_stream():
        if not _refresh_lock.acquire(blocking=False):
            # Another refresh is already in flight (e.g. manual click landed
            # while auto-refresh was running). Emit one skip event + a done so
            # the client closes cleanly; it can reload its data from the items
            # endpoint after the other run finishes writing.
            yield f"data: {json.dumps({'stage': 'busy', 'status': 'skipped', 'reason': 'a refresh is already running'})}\n\n"
            yield f"data: {json.dumps({'stage': 'done', 'status': 'done', 'skipped': True})}\n\n"
            return
        try:
            for stage in refresh_all_streaming(do_curate=curate):
                yield f"data: {json.dumps(stage)}\n\n"
        finally:
            _refresh_lock.release()

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/curate")
def post_curate(limit: int = 200):
    from . import curator
    n = curator.curate_pending(max_items=limit)
    return {"curated": n}


@app.post("/api/distill")
def post_distill():
    from . import distill
    return distill.distill_preferences()


@app.post("/api/name-clusters")
def post_name_clusters():
    from . import distill
    return distill.name_clusters()


@app.get("/api/constellation")
def get_constellation(limit: int = 5000):
    return {
        "items": db.items_for_constellation(limit=limit),
        "clusters": db.get_clusters(),
    }


def _rotate_if_needed(path: Path):
    if not path.exists() or path.stat().st_size < MAX_LOG_BYTES:
        return
    # path -> path.1; path.1 -> path.2; ...; oldest is dropped.
    for i in range(KEEP_ROTATIONS, 0, -1):
        src = path.with_suffix(path.suffix + f".{i}")
        dst = path.with_suffix(path.suffix + f".{i + 1}")
        if i == KEEP_ROTATIONS and src.exists():
            src.unlink()
        elif src.exists():
            src.rename(dst)
    path.rename(path.with_suffix(path.suffix + ".1"))


def _log_event(path: Path, event: dict):
    _rotate_if_needed(path)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


@app.post("/api/items/{item_id}/click")
def post_click(item_id: str):
    item = db.get_item(item_id)
    if not item:
        raise HTTPException(404, "item not found")
    db.set_status(item_id, "clicked")
    _log_event(
        CLICKS_LOG,
        {
            "ts": db.now_iso(),
            "item_id": item_id,
            "title": item["title"],
            "url": item["url"],
            "source": item["source_name"],
            "tags": item["tags"],
        },
    )
    return {"ok": True}


@app.post("/api/items/{item_id}/dismiss")
def post_dismiss(item_id: str):
    """Soft hide: removes from the list view, renders as a white dwarf on the
    constellation, ineligible for spotlight. Carries no ML signal — purely a
    UI gesture. Auto-purged after DISMISS_TTL_DAYS."""
    item = db.get_item(item_id)
    if not item:
        raise HTTPException(404, "item not found")
    db.set_status(item_id, "dismissed")
    _log_event(
        DISMISSES_LOG,
        {
            "ts": db.now_iso(),
            "item_id": item_id,
            "title": item["title"],
            "url": item["url"],
            "source": item["source_name"],
            "tags": item["tags"],
        },
    )
    return {"ok": True}


@app.post("/api/items/{item_id}/undismiss")
def post_undismiss(item_id: str):
    """Reverse the most recent dismiss. Used by the frontend's undo button.
    Only works on items currently in 'dismissed' status — won't touch items
    that have been clicked, rejected, or are still 'new'."""
    item = db.get_item(item_id)
    if not item:
        raise HTTPException(404, "item not found")
    if item.get("status") != "dismissed":
        raise HTTPException(400, f"item is '{item.get('status')}', not 'dismissed'")
    db.set_status(item_id, "new")
    return {"ok": True}


@app.post("/api/items/{item_id}/reject")
def post_reject(item_id: str, reason: str | None = None):
    item = db.get_item(item_id)
    if not item:
        raise HTTPException(404, "item not found")
    db.set_status(item_id, "rejected")
    _log_event(
        REJECTS_LOG,
        {
            "ts": db.now_iso(),
            "item_id": item_id,
            "title": item["title"],
            "url": item["url"],
            "source": item["source_name"],
            "tags": item["tags"],
            "reason": reason,
        },
    )
    return {"ok": True}


# Static frontend
if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    @app.get("/")
    def index():
        """Serve index.html with mtime-based cache-busting query strings on the
        script and stylesheet references. This is bulletproof against the
        WebView2 disk cache, which will sometimes ignore Cache-Control headers
        but is forced to refetch when the URL itself changes."""
        from fastapi.responses import HTMLResponse
        html = (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")
        for fname in ("styles.css", "constellation.js", "app.js"):
            fpath = FRONTEND_DIR / fname
            if fpath.exists():
                v = int(fpath.stat().st_mtime)
                html = html.replace(f"/static/{fname}", f"/static/{fname}?v={v}")
        return HTMLResponse(html)
