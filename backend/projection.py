"""UMAP projection + HDBSCAN clustering + persistent fitted-model state.

Strategy (the everynoise trick, with stability):
  1. Fit UMAP once on a baseline corpus (>= MIN_FIT_CORPUS items).
  2. Transform new items into the existing space (no re-fit each refresh).
  3. Periodically refit on accumulated data (every REFIT_EVERY items added).

HDBSCAN runs after each projection update. Clusters get optional AI labels
from cluster_labeler.py — kept separate so projection has zero AI deps.
"""

from __future__ import annotations

import threading
from pathlib import Path

import joblib
import numpy as np

from . import db
from .embeddings import bytes_to_vec, DIM

MODEL_PATH = Path(__file__).resolve().parent.parent / "data" / "umap_model.joblib"
_LEGACY_PICKLE_PATH = Path(__file__).resolve().parent.parent / "data" / "umap_model.pkl"

# UMAP transform isn't thread-safe; serialize concurrent project_all calls.
_project_lock = threading.Lock()
MIN_FIT_CORPUS = 50          # don't bother fitting until we have at least this many
REFIT_EVERY = 250            # refit when corpus has grown by this much since last fit
RANDOM_STATE = 42

# HDBSCAN params — these are gentle; tighten later as corpus grows
MIN_CLUSTER_SIZE = 6
MIN_SAMPLES = 3


def _load_fitted():
    # Drop legacy pickle if present — joblib is now the canonical store.
    if _LEGACY_PICKLE_PATH.exists():
        _LEGACY_PICKLE_PATH.unlink()
    if not MODEL_PATH.exists():
        return None
    try:
        return joblib.load(MODEL_PATH)
    except Exception:
        return None


def _save_fitted(state: dict):
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(state, MODEL_PATH)


def _embedding_matrix() -> tuple[list[str], np.ndarray]:
    rows = db.all_embeddings()
    if not rows:
        return [], np.zeros((0, DIM), dtype=np.float32)
    ids = [r[0] for r in rows]
    mat = np.vstack([bytes_to_vec(r[1]) for r in rows])
    return ids, mat


def _fit_umap(mat: np.ndarray):
    import umap
    n = mat.shape[0]
    # n_neighbors must be < n_samples; cap sensibly
    n_neighbors = max(2, min(15, n - 1))
    reducer = umap.UMAP(
        n_components=2,
        n_neighbors=n_neighbors,
        min_dist=0.1,
        metric="cosine",
        random_state=RANDOM_STATE,
        n_jobs=1,  # required when random_state is set
    )
    reducer.fit(mat)
    return reducer


def _cluster(coords: np.ndarray) -> np.ndarray:
    """HDBSCAN on 2D coords. Returns an int label per row (-1 = noise)."""
    if coords.shape[0] < MIN_CLUSTER_SIZE:
        return np.full(coords.shape[0], -1, dtype=int)
    from sklearn.cluster import HDBSCAN
    clusterer = HDBSCAN(
        min_cluster_size=MIN_CLUSTER_SIZE,
        min_samples=MIN_SAMPLES,
        cluster_selection_method="eom",
        copy=True,  # silence sklearn 1.10 default-change warning
    )
    return clusterer.fit_predict(coords)


def project_all() -> dict:
    """Project all embedded items, refitting UMAP if the corpus has grown enough.

    Returns a small report dict. Serialized via _project_lock to prevent
    concurrent fit/transform from corrupting the persisted model.
    """
    with _project_lock:
        return _project_all_locked()


def _project_all_locked() -> dict:
    ids, mat = _embedding_matrix()
    n = len(ids)
    report = {"items": n, "fitted": False, "clusters": 0}

    if n < MIN_FIT_CORPUS:
        report["status"] = f"need {MIN_FIT_CORPUS} items, have {n}"
        return report

    state = _load_fitted()
    last_fit_n = state["fit_size"] if state else 0
    needs_fit = state is None or (n - last_fit_n) >= REFIT_EVERY

    if needs_fit:
        reducer = _fit_umap(mat)
        state = {"reducer": reducer, "fit_size": n}
        _save_fitted(state)
        report["fitted"] = True
        coords = reducer.embedding_
    else:
        reducer = state["reducer"]
        coords = reducer.transform(mat)

    labels = _cluster(np.asarray(coords))
    report["clusters"] = int(labels.max()) + 1 if labels.size else 0

    rows = []
    for _id, (x, y), c in zip(ids, coords, labels):
        cluster_id = int(c) if c >= 0 else None
        rows.append((_id, float(x), float(y), cluster_id))
    db.store_projection(rows)

    # Update cluster table (centroids + counts; labels filled in later by AI)
    cluster_rows = []
    coords_np = np.asarray(coords)
    for cid in range(report["clusters"]):
        mask = labels == cid
        if not mask.any():
            continue
        cx = float(coords_np[mask, 0].mean())
        cy = float(coords_np[mask, 1].mean())
        cluster_rows.append({
            "id": cid,
            "label": None,
            "cx": cx,
            "cy": cy,
            "count": int(mask.sum()),
        })
    db.replace_clusters(cluster_rows)

    report["status"] = "ok"
    return report
