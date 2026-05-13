"""RSS/Atom fetcher built on feedparser.

Strips HTML out of summaries to give us a clean snippet. Tolerant of feeds with
missing fields — every RSS feed in the wild violates the spec in some creative
way.
"""

from __future__ import annotations

import html as html_lib
import re
import time
from datetime import datetime, timezone
from typing import Iterable

import feedparser

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _clean(raw: str | None, max_len: int = 400) -> str:
    if not raw:
        return ""
    text = _TAG_RE.sub(" ", raw)
    text = html_lib.unescape(text)
    text = _WS_RE.sub(" ", text).strip()
    return text[:max_len]


def _to_iso(parsed_struct) -> str | None:
    if not parsed_struct:
        return None
    try:
        ts = time.mktime(parsed_struct)
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")
    except Exception:
        return None


def fetch_rss(name: str, url: str, tags: list[str]) -> Iterable[tuple[dict, list[str]]]:
    """Fetch an RSS/Atom feed. Yields (item_dict, tags) pairs."""
    parsed = feedparser.parse(url, request_headers={"User-Agent": "constellar/0.1"})
    if parsed.bozo and not parsed.entries:
        # Hard failure (network error, malformed XML, nothing usable)
        return

    for entry in parsed.entries:
        link = entry.get("link")
        title = entry.get("title")
        if not link or not title:
            continue

        snippet = _clean(entry.get("summary") or entry.get("description"))
        published = _to_iso(entry.get("published_parsed") or entry.get("updated_parsed"))
        author = entry.get("author")

        item = {
            "source_kind": "rss",
            "source_name": name,
            "title": title.strip(),
            "url": link,
            "snippet": snippet,
            "author": author,
            "published_at": published,
            "raw": {"id": entry.get("id"), "feed": url},
        }
        yield item, tags
