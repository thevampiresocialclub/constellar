"""Daily distillation: rewrite preferences.md from accumulated clicks + rejects.

Uses claude-sonnet-4-6 (more nuance than Haiku for the once-a-day pattern-spotting
pass; only ~1 call per day so cost is trivial). Reads recent clicks.jsonl and
rejects.jsonl + the current preferences.md, writes back a refreshed file.

The output stays under ~2KB so it caches cheaply when injected into curator
calls hundreds of times per day.

Also handles cluster naming as a separate, smaller call (sample items per cluster
→ name the cluster).
"""

from __future__ import annotations

import json
import os
import random
import re
from pathlib import Path

from . import db

ROOT = Path(__file__).resolve().parent.parent
PREFS_PATH = ROOT / "data" / "preferences.md"
CLICKS_PATH = ROOT / "data" / "clicks.jsonl"
REJECTS_PATH = ROOT / "data" / "rejects.jsonl"
NAMES_PATH = Path(__file__).resolve().parent / "constellation_names.md"

DISTILL_MODEL = "claude-sonnet-4-6"
NAMING_MODEL = "claude-haiku-4-5"
RECENT_LIMIT = 200  # how many of each (clicks/rejects) to include


def _parse_constellation_names() -> list[dict]:
    """Parse the bundled names file into [{name, group, gloss}] entries.

    Section headers like "## Soft & Sibilant — tender lover's constellations"
    set the group; numbered list items are the actual names. Optional
    "— gloss" suffix is captured as a hint for the AI picker.
    """
    if not NAMES_PATH.exists():
        return []
    names: list[dict] = []
    current_group = "unknown"
    for line in NAMES_PATH.read_text(encoding="utf-8").splitlines():
        line = line.rstrip()
        if line.startswith("## "):
            # "## Soft & Sibilant — tender lover's constellations"
            current_group = line[3:].split(" — ")[0].strip()
            continue
        # Match "10. **Kohlra** — *KOHL-rah*  — gloss"
        m = re.match(r"^\s*\d+\.\s+\*\*([^*]+)\*\*(.*)$", line)
        if not m:
            continue
        name = m.group(1).strip()
        rest = m.group(2)
        # Optional human gloss after the pronunciation, separated by " — "
        gloss = None
        # Strip pronunciation (italic) chunk
        rest = re.sub(r"\*[^*]+\*", "", rest).strip()
        if " — " in rest:
            gloss = rest.split(" — ", 1)[1].strip().rstrip("—").strip()
        elif rest.startswith("—"):
            gloss = rest.lstrip("—").strip()
        names.append({"name": name, "group": current_group, "gloss": gloss or ""})
    return names


DISTILL_SYSTEM = """You maintain a user-preferences profile for a personal feed reader.
You will be given the current preferences file plus recent behavioral signal
(clicks = items the user opened, rejects = items the user dismissed).

Update the preferences file to reflect what the signal teaches you.

Constraints:
- Output must be valid Markdown, under 1500 words.
- Lead with "## Topics they're drawn to" and "## Topics they're avoiding" sections.
- Then "## Tone & format preferences" (do they like longform? memes? etc).
- Then "## Notes & nuance" — capture the *whys*, not just patterns.
  Example: "Rejects most crypto, but engages with crypto-adjacent fraud / drama"
  is more useful than "Avoids crypto."
- Preserve any existing "## User-locked notes" section verbatim — that's hand-edited.
- Never invent signal that isn't in the data. If recent activity is sparse, say so.

Return only the new file contents — no preamble, no markdown fences, no commentary."""


def _read_jsonl(path: Path, limit: int) -> list[dict]:
    """Tail-read up to `limit` lines so this stays bounded as logs grow.

    Avoids loading multi-MB files into memory just to read the last 200 lines.
    """
    if not path.exists():
        return []
    # Use deque to keep only the last `limit` lines while iterating.
    from collections import deque
    last_lines: deque[str] = deque(maxlen=limit)
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for ln in f:
            ln = ln.strip()
            if ln:
                last_lines.append(ln)
    out = []
    for ln in last_lines:
        try:
            out.append(json.loads(ln))
        except json.JSONDecodeError:
            continue
    return out


def _format_signal(events: list[dict], kind: str) -> str:
    if not events:
        return f"(no recent {kind})"
    lines = []
    for e in events:
        tags = ",".join(e.get("tags") or [])
        lines.append(f"- [{e.get('source', '?')}] {e.get('title', '?')}  ({tags})")
    return "\n".join(lines)


def distill_preferences() -> dict:
    """Rewrite preferences.md from recent clicks + rejects."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return {"ok": False, "reason": "ANTHROPIC_API_KEY not set"}

    clicks = _read_jsonl(CLICKS_PATH, RECENT_LIMIT)
    rejects = _read_jsonl(REJECTS_PATH, RECENT_LIMIT)
    if not clicks and not rejects:
        return {"ok": False, "reason": "no signal yet"}

    current = ""
    if PREFS_PATH.exists():
        current = PREFS_PATH.read_text(encoding="utf-8").strip()

    user_msg = (
        f"# Current preferences file\n\n{current or '(empty — write one from scratch)'}\n\n"
        f"# Recent clicks (positive signal)\n\n{_format_signal(clicks, 'clicks')}\n\n"
        f"# Recent rejects (negative signal)\n\n{_format_signal(rejects, 'rejects')}\n"
    )

    import anthropic
    client = anthropic.Anthropic(api_key=api_key)

    response = client.messages.create(
        model=DISTILL_MODEL,
        max_tokens=4000,
        system=DISTILL_SYSTEM,
        messages=[{"role": "user", "content": user_msg}],
    )
    new_text = next(b.text for b in response.content if b.type == "text").strip()

    PREFS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PREFS_PATH.write_text(new_text, encoding="utf-8")

    return {
        "ok": True,
        "clicks_seen": len(clicks),
        "rejects_seen": len(rejects),
        "preferences_chars": len(new_text),
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
    }


# ---------- cluster naming ----------

NAMING_SYSTEM = """You are naming constellations in a star-map of news + reddit items.
You will get clusters of items + a curated set of constellation names organized by mood/sound.

For each cluster, pick the BEST-FITTING name from the provided set based on the cluster's theme:
- Tender / soft / human content  → Soft & Sibilant
- Dark / drama / ominous content  → Hard-Edged & Gothic
- Sacred / serious / weighty      → Sacred & Devotional
- Important / civic / news        → Long & Ceremonial
- Snappy / topical / hot          → Short & Sharp
- Flowing / cultural / longform   → Flowing
- Anything that needs a wildcard  → Wild Cards

Each name can only be used once across all clusters. If the perfect name is taken, pick
the next best from the same group. Return JSON: {"labels":[{"id":<int>,"name":"<exact name>"},...]}.
Use the EXACT name string from the list — no inventing, no transliteration."""


def name_clusters() -> dict:
    """Assign each cluster a name from constellation_names.md.

    With ANTHROPIC_API_KEY set: Claude picks the best-fitting name per cluster
    based on the items in it, drawing from the appropriate mood group.
    Without an API key: deterministic round-robin assignment from the full list.
    """
    clusters = db.get_clusters()
    if not clusters:
        return {"ok": False, "reason": "no clusters yet"}

    names = _parse_constellation_names()
    if not names:
        return {"ok": False, "reason": "constellation_names.md missing or unparseable"}

    # Avoid reusing names already assigned to clusters that still exist.
    used = {c.get("label") for c in clusters if c.get("label")}
    available = [n for n in names if n["name"] not in used]

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return _name_clusters_offline(clusters, available)

    return _name_clusters_with_ai(clusters, available, api_key)


def _name_clusters_offline(clusters: list[dict], available: list[dict]) -> dict:
    """Deterministic fallback: assign names round-robin from the available pool."""
    if not available:
        return {"ok": False, "reason": "no unused names left in pool"}
    rng = random.Random(42)
    pool = available[:]
    rng.shuffle(pool)
    named = 0
    with db.connect() as conn:
        for i, c in enumerate(clusters):
            if c.get("label"):
                continue
            if not pool:
                break
            n = pool.pop()
            conn.execute("UPDATE clusters SET label = ? WHERE id = ?", (n["name"], c["id"]))
            named += 1
    return {"ok": True, "named": named, "method": "offline"}


def _name_clusters_with_ai(clusters: list[dict], available: list[dict], api_key: str) -> dict:
    # Sample up to 8 items per cluster, including any AI commentary for richer context.
    samples_by_cluster: dict[int, list[str]] = {}
    with db.connect() as conn:
        for c in clusters:
            if c.get("label"):
                continue
            rows = conn.execute(
                "SELECT title, ai_comment FROM items WHERE cluster_id = ? LIMIT 8",
                (c["id"],),
            ).fetchall()
            samples_by_cluster[c["id"]] = [
                f"{r['title']}" + (f" — {r['ai_comment']}" if r["ai_comment"] else "")
                for r in rows
            ]

    if not samples_by_cluster:
        return {"ok": True, "named": 0, "method": "skipped (all named)"}

    # Group available names so the model can see the palette.
    by_group: dict[str, list[str]] = {}
    for n in available:
        by_group.setdefault(n["group"], []).append(n["name"])

    palette_lines = []
    for group, names in by_group.items():
        palette_lines.append(f"\n## {group}\n  " + ", ".join(names))

    payload_lines = ["Available constellation names:\n" + "\n".join(palette_lines)]
    payload_lines.append("\n\nClusters to name:")
    for cid, titles in samples_by_cluster.items():
        payload_lines.append(f"\nCluster {cid}:")
        for t in titles:
            payload_lines.append(f"  - {t[:120]}")

    valid_names = [n["name"] for n in available]
    schema = {
        "type": "object",
        "properties": {
            "labels": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "integer"},
                        "name": {"type": "string", "enum": valid_names},
                    },
                    "required": ["id", "name"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["labels"],
        "additionalProperties": False,
    }

    import anthropic
    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=NAMING_MODEL,
        max_tokens=2000,
        system=NAMING_SYSTEM,
        messages=[{"role": "user", "content": "\n".join(payload_lines)}],
        output_config={"format": {"type": "json_schema", "schema": schema}},
    )
    text = next(b.text for b in response.content if b.type == "text")
    parsed = json.loads(text)

    # Dedupe: if the model picked the same name twice, second occurrence falls back.
    seen: set[str] = set()
    fallback_pool = [n["name"] for n in available]
    fallback_idx = 0
    chosen: list[tuple[str, int]] = []
    for entry in parsed.get("labels", []):
        name = entry["name"]
        if name in seen:
            while fallback_idx < len(fallback_pool) and fallback_pool[fallback_idx] in seen:
                fallback_idx += 1
            if fallback_idx >= len(fallback_pool):
                continue
            name = fallback_pool[fallback_idx]
        seen.add(name)
        chosen.append((name, entry["id"]))

    with db.connect() as conn:
        for name, cid in chosen:
            conn.execute("UPDATE clusters SET label = ? WHERE id = ?", (name, cid))

    return {"ok": True, "named": len(chosen), "method": "ai"}
