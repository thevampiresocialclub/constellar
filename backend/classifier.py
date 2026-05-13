"""Local "should this surface?" classifier — the cheap bouncer in front of Claude.

Trains on the user's clicks (positive) + rejects (negative) using their item
embeddings. Uses logistic regression with class balancing — fast, robust on
small data, well-calibrated probabilities.

Cold-start handling:
  - Below MIN_LABELS_PER_CLASS positives AND negatives, we don't train. Every
    item gets a permissive default score so the curator/UI sees everything.
  - The model is retrained from scratch each call (cheap on this scale —
    seconds even at tens of thousands of labels).

Model is persisted so /api/stats can report whether it's active without
re-fitting.
"""

from __future__ import annotations

from pathlib import Path

import joblib
import numpy as np

from . import db
from .embeddings import bytes_to_vec, DIM

MODEL_PATH = Path(__file__).resolve().parent.parent / "data" / "classifier.joblib"
_LEGACY_PICKLE_PATH = Path(__file__).resolve().parent.parent / "data" / "classifier.pkl"
MIN_LABELS_PER_CLASS = 25      # need at least this many of each before we trust the model
DEFAULT_SCORE = 0.7            # cold-start: be permissive, let things through
RANDOM_STATE = 42


def _load() -> dict | None:
    if _LEGACY_PICKLE_PATH.exists():
        _LEGACY_PICKLE_PATH.unlink()
    if not MODEL_PATH.exists():
        return None
    try:
        return joblib.load(MODEL_PATH)
    except Exception:
        return None


def _save(state: dict):
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(state, MODEL_PATH)


def _train() -> dict | None:
    """Train a fresh classifier if we have enough labels. Returns state or None."""
    embs_bytes, labels = db.labeled_items_for_classifier()
    if not embs_bytes:
        return None

    pos = sum(1 for y in labels if y == 1)
    neg = sum(1 for y in labels if y == 0)
    if pos < MIN_LABELS_PER_CLASS or neg < MIN_LABELS_PER_CLASS:
        return None

    from sklearn.linear_model import LogisticRegression

    X = np.vstack([bytes_to_vec(b) for b in embs_bytes])
    y = np.asarray(labels, dtype=np.int64)

    clf = LogisticRegression(
        max_iter=500,
        class_weight="balanced",   # don't drown in the more common label
        C=1.0,
        random_state=RANDOM_STATE,
    )
    clf.fit(X, y)

    return {
        "classifier": clf,
        "n_pos": pos,
        "n_neg": neg,
        "trained_at": db.now_iso(),
    }


def score_pending(limit: int = 5000) -> int:
    """Score every item that has an embedding but no classifier score yet.

    Trains/refreshes the model first. Returns the number of items scored.
    """
    state = _train() or _load()

    if state is not None and "classifier" in state:
        _save(state)

    with db.connect() as conn:
        rows = conn.execute(
            """
            SELECT id, embedding FROM items
            WHERE embedding IS NOT NULL AND score IS NULL
            ORDER BY fetched_at DESC LIMIT ?
            """,
            (limit,),
        ).fetchall()

    if not rows:
        return 0

    if state is None or "classifier" not in state:
        # Cold start — give everything the permissive default
        scores = [(r["id"], DEFAULT_SCORE) for r in rows]
        db.store_classifier_scores(scores)
        return len(scores)

    clf = state["classifier"]
    X = np.vstack([bytes_to_vec(r["embedding"]) for r in rows])
    probs = clf.predict_proba(X)[:, 1]   # P(clicked)
    scores = [(r["id"], float(p)) for r, p in zip(rows, probs)]
    db.store_classifier_scores(scores)
    return len(scores)


def classifier_status() -> dict:
    state = _load()
    if state is None:
        return {"trained": False, "reason": "no model on disk yet"}
    return {
        "trained": True,
        "n_pos": state.get("n_pos"),
        "n_neg": state.get("n_neg"),
        "trained_at": state.get("trained_at"),
    }
