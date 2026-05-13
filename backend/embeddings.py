"""Local embeddings via fastembed (ONNX runtime, no PyTorch).

We use BAAI/bge-small-en-v1.5: 384-dim, ~33MB, very fast on CPU.
Embeddings are stored as raw float32 bytes in SQLite.
"""

from __future__ import annotations

import threading

import numpy as np

from . import db

MODEL_NAME = "BAAI/bge-small-en-v1.5"
DIM = 384
PAGE_SIZE = 500  # how many items to pull per loop iteration

_model = None
_model_lock = threading.Lock()


def _get_model():
    """Lazy load the embedding model, thread-safe.

    Two concurrent /api/refresh calls during cold start would otherwise both
    download and instantiate the model. Double-checked locking keeps the
    fast path lock-free.
    """
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from fastembed import TextEmbedding
                _model = TextEmbedding(model_name=MODEL_NAME)
    return _model


def _text_for(item: dict) -> str:
    parts = [item.get("title") or ""]
    if item.get("ai_comment"):
        parts.append(item["ai_comment"])
    if item.get("snippet"):
        parts.append(item["snippet"][:300])
    if item.get("source_name"):
        parts.append(f"[{item['source_name']}]")
    return " — ".join(p for p in parts if p)


def vec_to_bytes(vec) -> bytes:
    return np.asarray(vec, dtype=np.float32).tobytes()


def bytes_to_vec(b: bytes) -> np.ndarray:
    return np.frombuffer(b, dtype=np.float32)


def embed_pending(batch_size: int = 64) -> int:
    """Embed every item without an embedding. Pages through to handle any
    backlog size (the previous 10k cap silently dropped overflow)."""
    model = _get_model()
    total = 0
    while True:
        items = db.items_needing_embedding(limit=PAGE_SIZE)
        if not items:
            break

        texts = [_text_for(it) for it in items]
        rows: list[tuple[str, bytes, str]] = []
        for item, vec in zip(items, model.embed(texts, batch_size=batch_size)):
            rows.append((item["id"], vec_to_bytes(vec), MODEL_NAME))

        db.store_embeddings(rows)
        total += len(rows)

        if len(items) < PAGE_SIZE:
            break

    return total
