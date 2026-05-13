import sqlite3
import json
import hashlib
from pathlib import Path
from contextlib import contextmanager
from datetime import datetime, timezone

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "feed.db"

# Versioned schema: each migration is one DDL string applied in order.
# Bump SCHEMA_VERSION and append to MIGRATIONS — never edit prior entries.
SCHEMA_VERSION = 2

MIGRATIONS = [
    # v1: initial schema
    """
    CREATE TABLE IF NOT EXISTS items (
        id              TEXT PRIMARY KEY,
        source_kind     TEXT NOT NULL,
        source_name     TEXT NOT NULL,
        title           TEXT NOT NULL,
        url             TEXT NOT NULL UNIQUE,
        snippet         TEXT,
        author          TEXT,
        published_at    TEXT,
        fetched_at      TEXT NOT NULL,
        raw             TEXT,
        status          TEXT NOT NULL DEFAULT 'new',
        score           REAL,
        ai_score        REAL,
        ai_comment      TEXT,
        embedding       BLOB,
        embed_model     TEXT,
        umap_x          REAL,
        umap_y          REAL,
        cluster_id      INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_items_status     ON items(status);
    CREATE INDEX IF NOT EXISTS idx_items_fetched_at ON items(fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_items_source     ON items(source_kind, source_name);
    CREATE INDEX IF NOT EXISTS idx_items_embed_null ON items(id) WHERE embedding IS NULL;
    CREATE INDEX IF NOT EXISTS idx_items_umap_null  ON items(id) WHERE umap_x IS NULL;
    CREATE INDEX IF NOT EXISTS idx_items_cluster    ON items(cluster_id);

    CREATE TABLE IF NOT EXISTS item_tags (
        item_id     TEXT NOT NULL,
        tag         TEXT NOT NULL,
        applied_by  TEXT NOT NULL DEFAULT 'source',
        PRIMARY KEY (item_id, tag),
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag);

    CREATE TABLE IF NOT EXISTS clusters (
        id            INTEGER PRIMARY KEY,
        label         TEXT,
        centroid_x    REAL,
        centroid_y    REAL,
        member_count  INTEGER,
        updated_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
    );
    """,
    # v2: extracted vote count for Reddit items (drives star sizing)
    """
    ALTER TABLE items ADD COLUMN votes INTEGER;
    """,
]


def make_id(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    """Apply migrations from the current version forward.

    On a fresh DB: applies all migrations in order.
    On an existing DB: applies only migrations newer than meta.schema_version.
    Idempotent — safe to call on every startup.
    """
    with connect() as conn:
        # Bootstrap meta table without depending on the schema yet.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)"
        )
        row = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
        current = int(row[0]) if row else 0

        for i, ddl in enumerate(MIGRATIONS, start=1):
            if i > current:
                conn.executescript(ddl)

        # Post-migration data backfill: when v2 added the votes column,
        # any existing rows have NULL — pull the value out of the stored raw JSON.
        if current < 2 <= SCHEMA_VERSION:
            _backfill_votes_from_raw(conn)

        if current < SCHEMA_VERSION:
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('schema_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(SCHEMA_VERSION),),
            )


def _backfill_votes_from_raw(conn):
    rows = conn.execute(
        "SELECT id, raw FROM items WHERE votes IS NULL AND raw IS NOT NULL"
    ).fetchall()
    updates = []
    for r in rows:
        try:
            raw = json.loads(r["raw"])
            score = raw.get("score") if isinstance(raw, dict) else None
            if isinstance(score, (int, float)):
                updates.append((int(score), r["id"]))
        except (json.JSONDecodeError, TypeError):
            continue
    if updates:
        conn.executemany("UPDATE items SET votes = ? WHERE id = ?", updates)


def upsert_item(item: dict, tags: list[str]) -> bool:
    """Insert item if new. Returns True if inserted, False if already existed."""
    item_id = make_id(item["url"])
    raw = item.get("raw", {}) or {}
    # Pull vote count out of raw for direct sorting/sizing. Only Reddit items
    # have this — RSS news items leave it NULL (sized by recency on the frontend).
    votes = raw.get("score") if isinstance(raw, dict) else None
    with connect() as conn:
        existing = conn.execute("SELECT 1 FROM items WHERE id = ?", (item_id,)).fetchone()
        if existing:
            return False
        conn.execute(
            """
            INSERT INTO items (id, source_kind, source_name, title, url, snippet,
                               author, published_at, fetched_at, raw, votes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item_id,
                item["source_kind"],
                item["source_name"],
                item["title"],
                item["url"],
                item.get("snippet"),
                item.get("author"),
                item.get("published_at"),
                now_iso(),
                json.dumps(raw, default=str),
                votes,
            ),
        )
        for tag in tags:
            conn.execute(
                "INSERT OR IGNORE INTO item_tags (item_id, tag, applied_by) VALUES (?, ?, 'source')",
                (item_id, tag),
            )
        return True


def list_items(status: str | None = "new", limit: int = 200) -> list[dict]:
    # Explicit column list excludes the raw `embedding` blob — JSON-serializing
    # that returns garbage and breaks /api/items.
    sql = """
        SELECT i.id, i.source_kind, i.source_name, i.title, i.url, i.snippet,
               i.author, i.published_at, i.fetched_at, i.status,
               i.score, i.ai_score, i.ai_comment,
               i.umap_x, i.umap_y, i.cluster_id,
               GROUP_CONCAT(t.tag) AS tags
        FROM items i
        LEFT JOIN item_tags t ON t.item_id = i.id
        {where}
        GROUP BY i.id
        ORDER BY COALESCE(i.published_at, i.fetched_at) DESC
        LIMIT ?
    """
    params: list = []
    where = ""
    if status:
        where = "WHERE i.status = ?"
        params.append(status)
    params.append(limit)

    with connect() as conn:
        rows = conn.execute(sql.format(where=where), params).fetchall()
        return [_row_to_dict(r) for r in rows]


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["tags"] = d["tags"].split(",") if d.get("tags") else []
    return d


def set_status(item_id: str, status: str) -> bool:
    with connect() as conn:
        cur = conn.execute("UPDATE items SET status = ? WHERE id = ?", (status, item_id))
        return cur.rowcount > 0


def get_item(item_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            """
            SELECT i.id, i.source_kind, i.source_name, i.title, i.url, i.snippet,
                   i.author, i.published_at, i.fetched_at, i.status,
                   i.score, i.ai_score, i.ai_comment,
                   i.umap_x, i.umap_y, i.cluster_id,
                   GROUP_CONCAT(t.tag) AS tags
            FROM items i LEFT JOIN item_tags t ON t.item_id = i.id
            WHERE i.id = ? GROUP BY i.id
            """,
            (item_id,),
        ).fetchone()
        return _row_to_dict(row) if row else None


def stats() -> dict:
    with connect() as conn:
        total = conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        by_status = dict(
            conn.execute("SELECT status, COUNT(*) FROM items GROUP BY status").fetchall()
        )
        by_source = dict(
            conn.execute(
                "SELECT source_name, COUNT(*) FROM items GROUP BY source_name ORDER BY 2 DESC"
            ).fetchall()
        )
        embedded = conn.execute(
            "SELECT COUNT(*) FROM items WHERE embedding IS NOT NULL"
        ).fetchone()[0]
        projected = conn.execute(
            "SELECT COUNT(*) FROM items WHERE umap_x IS NOT NULL"
        ).fetchone()[0]
        curated = conn.execute(
            "SELECT COUNT(*) FROM items WHERE ai_comment IS NOT NULL"
        ).fetchone()[0]
        # Newest fetched_at drives the frontend's auto-refresh-on-launch
        # staleness check. None when the DB is empty.
        newest_fetched_at = conn.execute(
            "SELECT MAX(fetched_at) FROM items"
        ).fetchone()[0]
        return {
            "total": total,
            "by_status": by_status,
            "by_source": by_source,
            "embedded": embedded,
            "projected": projected,
            "curated": curated,
            "newest_fetched_at": newest_fetched_at,
        }


# ---------- embeddings + projection helpers ----------

def items_needing_embedding(limit: int = 500) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, title, snippet, source_name, ai_comment
            FROM items
            WHERE embedding IS NULL
            ORDER BY fetched_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def store_embeddings(rows: list[tuple[str, bytes, str]]):
    """rows: list of (item_id, embedding_bytes, model_name)."""
    with connect() as conn:
        conn.executemany(
            "UPDATE items SET embedding = ?, embed_model = ? WHERE id = ?",
            [(emb, model, _id) for _id, emb, model in rows],
        )


def all_embeddings() -> list[tuple[str, bytes]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, embedding FROM items WHERE embedding IS NOT NULL"
        ).fetchall()
        return [(r["id"], r["embedding"]) for r in rows]


def store_projection(rows: list[tuple[str, float, float, int | None]]):
    """rows: list of (item_id, umap_x, umap_y, cluster_id)."""
    with connect() as conn:
        conn.executemany(
            "UPDATE items SET umap_x = ?, umap_y = ?, cluster_id = ? WHERE id = ?",
            [(x, y, c, _id) for _id, x, y, c in rows],
        )


def replace_clusters(clusters: list[dict]):
    with connect() as conn:
        conn.execute("DELETE FROM clusters")
        conn.executemany(
            """INSERT INTO clusters (id, label, centroid_x, centroid_y, member_count, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [
                (c["id"], c.get("label"), c["cx"], c["cy"], c["count"], now_iso())
                for c in clusters
            ],
        )


def get_clusters() -> list[dict]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM clusters ORDER BY member_count DESC").fetchall()
        return [dict(r) for r in rows]


def items_for_constellation(limit: int = 5000) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT i.id, i.title, i.url, i.snippet, i.source_kind, i.source_name,
                   i.published_at, i.fetched_at, i.ai_comment, i.ai_score, i.score,
                   i.umap_x, i.umap_y, i.cluster_id, i.status, i.votes,
                   GROUP_CONCAT(t.tag) AS tags
            FROM items i
            LEFT JOIN item_tags t ON t.item_id = i.id
            WHERE i.umap_x IS NOT NULL AND i.status NOT IN ('rejected')
            GROUP BY i.id
            ORDER BY i.fetched_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [_row_to_dict(r) for r in rows]


def items_needing_curation(limit: int = 100) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, title, snippet, source_name, source_kind
            FROM items
            WHERE ai_comment IS NULL AND status = 'new'
            ORDER BY COALESCE(published_at, fetched_at) DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def store_curation(rows: list[dict]):
    """rows: dicts with id, ai_score, ai_comment, tags."""
    with connect() as conn:
        for r in rows:
            conn.execute(
                "UPDATE items SET ai_score = ?, ai_comment = ? WHERE id = ?",
                (r.get("ai_score"), r.get("ai_comment"), r["id"]),
            )
            for tag in r.get("tags", []) or []:
                conn.execute(
                    "INSERT OR IGNORE INTO item_tags (item_id, tag, applied_by) VALUES (?, ?, 'ai')",
                    (r["id"], tag),
                )


def labeled_items_for_classifier() -> tuple[list[bytes], list[int]]:
    """Returns (embeddings, labels) where label=1 for clicked, 0 for rejected."""
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT embedding, status FROM items
            WHERE embedding IS NOT NULL AND status IN ('clicked', 'rejected')
            """
        ).fetchall()
        embs = []
        labels = []
        for r in rows:
            embs.append(r["embedding"])
            labels.append(1 if r["status"] == "clicked" else 0)
        return embs, labels


def store_classifier_scores(rows: list[tuple[str, float]]):
    with connect() as conn:
        conn.executemany(
            "UPDATE items SET score = ? WHERE id = ?",
            [(score, _id) for _id, score in rows],
        )


def purge_old_dismissed(days: int = 90) -> int:
    """Hard-delete dismissed items whose status flipped to 'dismissed' more than
    `days` ago. We approximate the dismissal time with fetched_at — a dismissed
    item's fetched_at is at most as recent as when the user saw it, so an item
    older than `days` has been around (and dismissed) for at least that long.

    Returns count deleted. Run on startup; cheap even at thousands of rows.
    """
    cutoff = datetime.now(timezone.utc).isoformat(timespec="seconds")
    # SQLite supports datetime arithmetic via the `datetime()` function.
    with connect() as conn:
        cur = conn.execute(
            """
            DELETE FROM items
            WHERE status = 'dismissed'
              AND fetched_at < datetime(?, ?)
            """,
            (cutoff, f"-{int(days)} days"),
        )
        return cur.rowcount


def get_meta(key: str, default: str | None = None) -> str | None:
    with connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else default


def set_meta(key: str, value: str):
    with connect() as conn:
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
