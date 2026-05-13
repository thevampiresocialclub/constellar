"""Claude curator: per-item one-line take + score + topic-tag suggestions.

Uses claude-haiku-4-5 for bulk curation (chosen during design — Haiku is plenty
sharp for "should this surface, what's the take" and lets us run on hundreds
of items/day for ~$10/mo).

Architecture:
  - Items are batched (default 20 per call) to amortize per-call overhead.
  - The system prompt + preferences memory are cached via prompt caching,
    so each call only pays full-rate input on the items themselves.
  - Structured output via output_config.format (json_schema) returns one
    record per item, parsed and stored.

If ANTHROPIC_API_KEY is unset, curate_pending() short-circuits with 0 work —
the system stays usable without AI.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from . import db

MODEL = "claude-haiku-4-5"
BATCH_SIZE = 20
MAX_TOKENS = 4000

PREFS_PATH = Path(__file__).resolve().parent.parent / "data" / "preferences.md"

SYSTEM_PROMPT = """You are the curator for a personal news + reddit feed reader called Constellar.
Your job is to look at incoming items and decide which deserve the user's attention right now,
write a one-line take that makes the case (or doesn't), and suggest 1-3 topic tags.

For each item you receive, return:
  - relevance: a float from 0.0 to 1.0. Higher = more worth surfacing right now.
              0.9+ = "they will want to see this"
              0.5  = "borderline, depends on mood"
              <0.2 = "filler, low-signal, or duplicate of something they've seen"
  - comment:   one short sentence (under 140 chars) — the *hook*, not a summary.
              Funny, sharp, or genuinely informative. Never marketing-speak.
              Example good:  "wallstreetbets discovers fundamentals, briefly"
              Example good:  "buried lede — the actual policy change is in paragraph 8"
              Example bad:   "An interesting article about X" (lifeless)
              Example bad:   "Click to read more" (useless)
  - tags:      1-3 lowercase topic tags (e.g. "ai", "console-wars", "crypto-grift",
              "la-local", "geopolitics"). Reuse existing taxonomy where it fits;
              propose new tags only when nothing existing applies. Do NOT include
              the source name (kotaku, r/wallstreetbets, etc.) — those are auto-tagged.

Calibrate aggressively to the preferences memory below. If the user clearly hates
something, score it low and say so plainly in the comment. If they clearly love
something, surface it confidently."""


def _load_preferences() -> str:
    """Read + normalize preferences.md so prompt caching stays stable.

    Trailing whitespace, BOM, or stray CRLFs would otherwise silently
    invalidate the cached prefix on every call.
    """
    if not PREFS_PATH.exists():
        return "(no preferences memory yet — use neutral, slightly skeptical defaults)"
    raw = PREFS_PATH.read_text(encoding="utf-8")
    # Strip BOM if present
    if raw.startswith("﻿"):
        raw = raw[1:]
    # Normalize line endings, strip trailing whitespace per-line, collapse blanks
    lines = [ln.rstrip() for ln in raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return "\n".join(lines).strip()


def _build_system_blocks() -> list[dict]:
    """System prompt + preferences memory, cached as one prefix."""
    prefs = _load_preferences()
    return [
        {"type": "text", "text": SYSTEM_PROMPT},
        {
            "type": "text",
            "text": f"\n\n# User preference memory\n\n{prefs}",
            "cache_control": {"type": "ephemeral"},
        },
    ]


def _format_batch(items: list[dict]) -> str:
    lines = ["Score the following items. Return one record per item, in the same order.\n"]
    for i, it in enumerate(items, start=1):
        snippet = (it.get("snippet") or "").strip()[:300]
        lines.append(
            f"[{i}] id={it['id']} | source={it['source_name']} ({it['source_kind']})\n"
            f"    title: {it['title']}\n"
            f"    snippet: {snippet}\n"
        )
    return "\n".join(lines)


_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "echo back the item id"},
                    "relevance": {"type": "number"},
                    "comment": {"type": "string", "maxLength": 200},
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                        "maxItems": 3,
                    },
                },
                "required": ["id", "relevance", "comment", "tags"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


def _curate_batch(client, items: list[dict]) -> list[dict]:
    response = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=_build_system_blocks(),
        messages=[{"role": "user", "content": _format_batch(items)}],
        output_config={"format": {"type": "json_schema", "schema": _RESPONSE_SCHEMA}},
    )

    text = next(b.text for b in response.content if b.type == "text")
    parsed = json.loads(text)

    cache_read = getattr(response.usage, "cache_read_input_tokens", 0)
    cache_write = getattr(response.usage, "cache_creation_input_tokens", 0)
    print(
        f"[curator] batch={len(items)} "
        f"in={response.usage.input_tokens} cache_r={cache_read} cache_w={cache_write} "
        f"out={response.usage.output_tokens}"
    )
    return parsed["items"]


def curate_pending(max_items: int = 200) -> int:
    """Curate up to max_items new items. Returns number actually curated."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return 0

    pending = db.items_needing_curation(limit=max_items)
    if not pending:
        return 0

    import anthropic
    client = anthropic.Anthropic(api_key=api_key)

    total = 0
    for start in range(0, len(pending), BATCH_SIZE):
        batch = pending[start : start + BATCH_SIZE]
        try:
            results = _curate_batch(client, batch)
        except Exception as e:
            print(f"[curator] batch failed: {e!r}")
            continue

        rows = []
        for r in results:
            rows.append({
                "id": r["id"],
                "ai_score": float(r.get("relevance", 0.5)),
                "ai_comment": r.get("comment", "").strip(),
                "tags": [t.strip().lower() for t in r.get("tags", []) if t.strip()],
            })
        db.store_curation(rows)
        total += len(rows)

    return total
