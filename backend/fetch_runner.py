"""Coordinates a full refresh across all configured sources."""

from __future__ import annotations

import json
import os
import sqlite3
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterator

import httpx
from prawcore.exceptions import PrawcoreException

from . import db
from .fetchers.rss import fetch_rss
from .fetchers.reddit import fetch_reddit

SOURCES_PATH = Path(__file__).resolve().parent.parent / "data" / "sources.json"

# Network/data errors we expect from individual fetchers and can survive.
# Anything else propagates so it's actually visible.
_FETCH_ERRORS = (
    httpx.HTTPError,
    urllib.error.URLError,
    PrawcoreException,
    sqlite3.OperationalError,  # locked DB under heavy concurrency
    ValueError,                # malformed feed entries
    KeyError,
)


def load_sources() -> dict:
    with SOURCES_PATH.open("r", encoding="utf-8") as f:
        cfg = json.load(f)

    # Allow Reddit creds to come from environment instead of plaintext config.
    reddit = cfg.get("reddit", {})
    creds = reddit.get("credentials", {})
    for key, env in (
        ("client_id", "REDDIT_CLIENT_ID"),
        ("client_secret", "REDDIT_CLIENT_SECRET"),
        ("username", "REDDIT_USERNAME"),
        ("password", "REDDIT_PASSWORD"),
    ):
        env_val = os.environ.get(env)
        if env_val:
            creds[key] = env_val
    reddit["credentials"] = creds
    return cfg


def _run_rss(name: str, url: str, tags: list[str]) -> tuple[str, int, int, str | None]:
    inserted = seen = 0
    err = None
    try:
        for item, item_tags in fetch_rss(name, url, tags):
            seen += 1
            if db.upsert_item(item, item_tags):
                inserted += 1
    except _FETCH_ERRORS as e:
        err = repr(e)
    return name, inserted, seen, err


def _run_reddit(reddit_cfg: dict) -> tuple[str, int, int, str | None]:
    inserted = seen = 0
    err = None
    try:
        for item, item_tags in fetch_reddit(reddit_cfg):
            seen += 1
            if db.upsert_item(item, item_tags):
                inserted += 1
    except _FETCH_ERRORS as e:
        err = repr(e)
    return "reddit", inserted, seen, err


def refresh_all(do_embed: bool = True, do_project: bool = True,
                do_curate: bool = False, do_score: bool = True) -> dict:
    """Fetch every source in parallel, then run the post-processing pipeline.

    Stages, in order, each independently toggleable:
      1. fetch (RSS + Reddit, parallel)
      2. embed pending items (local fastembed)
      3. project all embeddings to 2D via UMAP + HDBSCAN
      4. score new items with the classifier (cheap gate)
      5. curate (Claude) — disabled by default; expensive
    """
    db.init_db()
    sources = load_sources()
    started = time.time()
    report = {"sources": [], "totals": {"inserted": 0, "seen": 0}, "stages": {}}

    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = []
        for s in sources.get("rss", []):
            futures.append(ex.submit(_run_rss, s["name"], s["url"], s.get("tags", [])))
        if sources.get("reddit"):
            futures.append(ex.submit(_run_reddit, sources["reddit"]))

        for fut in as_completed(futures):
            name, inserted, seen, err = fut.result()
            report["sources"].append(
                {"name": name, "inserted": inserted, "seen": seen, "error": err}
            )
            report["totals"]["inserted"] += inserted
            report["totals"]["seen"] += seen

    report["stages"]["fetch_sec"] = round(time.time() - started, 2)

    # ---- post-processing ----
    if do_embed:
        t0 = time.time()
        try:
            from . import embeddings
            n = embeddings.embed_pending()
            report["stages"]["embedded"] = n
            report["stages"]["embed_sec"] = round(time.time() - t0, 2)
        except Exception as e:
            report["stages"]["embed_error"] = repr(e)

    if do_project:
        t0 = time.time()
        try:
            from . import projection
            proj_report = projection.project_all()
            report["stages"]["projection"] = proj_report
            report["stages"]["project_sec"] = round(time.time() - t0, 2)
        except Exception as e:
            report["stages"]["project_error"] = repr(e)

    if do_score:
        t0 = time.time()
        try:
            from . import classifier
            n = classifier.score_pending()
            report["stages"]["scored"] = n
            report["stages"]["score_sec"] = round(time.time() - t0, 2)
        except Exception as e:
            report["stages"]["score_error"] = repr(e)

    if do_curate:
        t0 = time.time()
        try:
            from . import curator
            n = curator.curate_pending()
            report["stages"]["curated"] = n
            report["stages"]["curate_sec"] = round(time.time() - t0, 2)
        except Exception as e:
            report["stages"]["curate_error"] = repr(e)

    # Cluster naming. Always runs — uses Claude if ANTHROPIC_API_KEY is set,
    # otherwise the deterministic offline picker. Projection wipes labels on
    # every refresh, so without this the frontend would always show the
    # "cluster N · M" placeholder.
    t0 = time.time()
    try:
        from . import distill
        report["stages"]["name_clusters"] = distill.name_clusters()
        report["stages"]["name_clusters_sec"] = round(time.time() - t0, 2)
    except Exception as e:
        report["stages"]["name_clusters_error"] = repr(e)

    report["elapsed_sec"] = round(time.time() - started, 2)
    return report


def refresh_all_streaming(do_curate: bool = True) -> Iterator[dict]:
    """Same pipeline as refresh_all() but yields stage events as they complete.

    Auto-curates and auto-names clusters when ANTHROPIC_API_KEY is set.
    Yields dicts with {stage, status, ...details}. Final stage is {stage: 'done'}.
    """
    db.init_db()
    has_api_key = bool(os.environ.get("ANTHROPIC_API_KEY"))

    yield {"stage": "fetch", "status": "start"}
    sources = load_sources()
    started = time.time()
    fetch_inserted = fetch_seen = 0
    per_source = []

    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = []
        for s in sources.get("rss", []):
            futures.append(ex.submit(_run_rss, s["name"], s["url"], s.get("tags", [])))
        if sources.get("reddit"):
            futures.append(ex.submit(_run_reddit, sources["reddit"]))

        for fut in as_completed(futures):
            name, inserted, seen, err = fut.result()
            per_source.append({"name": name, "inserted": inserted, "seen": seen, "error": err})
            fetch_inserted += inserted
            fetch_seen += seen

    yield {
        "stage": "fetch", "status": "done",
        "inserted": fetch_inserted, "seen": fetch_seen,
        "elapsed_sec": round(time.time() - started, 2),
        "sources": per_source,
    }

    yield {"stage": "embed", "status": "start"}
    try:
        from . import embeddings
        t = time.time()
        n = embeddings.embed_pending()
        yield {"stage": "embed", "status": "done", "embedded": n,
               "elapsed_sec": round(time.time() - t, 2)}
    except Exception as e:
        yield {"stage": "embed", "status": "error", "error": repr(e)}

    yield {"stage": "project", "status": "start"}
    try:
        from . import projection
        t = time.time()
        rep = projection.project_all()
        yield {"stage": "project", "status": "done", **rep,
               "elapsed_sec": round(time.time() - t, 2)}
    except Exception as e:
        yield {"stage": "project", "status": "error", "error": repr(e)}

    yield {"stage": "score", "status": "start"}
    try:
        from . import classifier
        t = time.time()
        n = classifier.score_pending()
        yield {"stage": "score", "status": "done", "scored": n,
               "elapsed_sec": round(time.time() - t, 2)}
    except Exception as e:
        yield {"stage": "score", "status": "error", "error": repr(e)}

    # Curate needs an API key — skip gracefully if missing.
    if do_curate and has_api_key:
        yield {"stage": "curate", "status": "start"}
        try:
            from . import curator
            t = time.time()
            n = curator.curate_pending()
            yield {"stage": "curate", "status": "done", "curated": n,
                   "elapsed_sec": round(time.time() - t, 2)}
        except Exception as e:
            yield {"stage": "curate", "status": "error", "error": repr(e)}
    elif do_curate and not has_api_key:
        yield {"stage": "curate", "status": "skipped", "reason": "ANTHROPIC_API_KEY not set"}

    # Cluster naming runs unconditionally. `distill.name_clusters()` uses Claude
    # when ANTHROPIC_API_KEY is set, otherwise falls back to deterministic
    # round-robin naming from constellation_names.md. Without this stage, the
    # projection step (which always runs) wipes existing cluster labels and
    # leaves the frontend showing "cluster N · M" placeholders forever.
    yield {"stage": "name_clusters", "status": "start"}
    try:
        from . import distill
        t = time.time()
        r = distill.name_clusters()
        yield {"stage": "name_clusters", "status": "done", **r,
               "elapsed_sec": round(time.time() - t, 2)}
    except Exception as e:
        yield {"stage": "name_clusters", "status": "error", "error": repr(e)}

    yield {"stage": "done", "status": "done",
           "total_elapsed_sec": round(time.time() - started, 2)}


if __name__ == "__main__":
    print(json.dumps(refresh_all(), indent=2))
