"""Reddit fetcher with two paths:

1. PRAW (rich data, sort modes, scores) when client_id + client_secret are set.
2. .rss fallback (no auth, limited) when credentials are absent.

Frontpage:
- With credentials + username/password → personalized frontpage.
- Read-only credentials → r/popular (Reddit's logged-out frontpage equivalent).
- No credentials → r/popular via .rss.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable

from .rss import fetch_rss


def _has_credentials(creds: dict) -> bool:
    return bool(creds.get("client_id") and creds.get("client_secret"))


def _has_user_auth(creds: dict) -> bool:
    return _has_credentials(creds) and bool(creds.get("username") and creds.get("password"))


def _ts_to_iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")
    except Exception:
        return None


def _praw_client(creds: dict):
    import praw
    kwargs = {
        "client_id": creds["client_id"],
        "client_secret": creds["client_secret"],
        "user_agent": creds.get("user_agent", "constellar/0.1"),
    }
    if _has_user_auth(creds):
        kwargs["username"] = creds["username"]
        kwargs["password"] = creds["password"]
    return praw.Reddit(**kwargs)


def _submission_to_item(sub, source_name: str) -> dict:
    is_self = getattr(sub, "is_self", False)
    permalink = f"https://reddit.com{sub.permalink}"
    target_url = permalink if is_self else (sub.url or permalink)
    snippet = (sub.selftext or "")[:400] if is_self else ""

    return {
        "source_kind": "reddit",
        "source_name": source_name,
        "title": sub.title,
        "url": target_url,
        "snippet": snippet,
        "author": str(sub.author) if sub.author else None,
        "published_at": _ts_to_iso(getattr(sub, "created_utc", None)),
        "raw": {
            "permalink": permalink,
            "score": getattr(sub, "score", None),
            "num_comments": getattr(sub, "num_comments", None),
            "subreddit": str(sub.subreddit),
            "is_self": is_self,
            "over_18": getattr(sub, "over_18", False),
        },
    }


def _iter_listing(listing, sort: str, limit: int):
    sort_method = {
        "hot": listing.hot,
        "new": listing.new,
        "top": lambda limit: listing.top(time_filter="day", limit=limit),
        "rising": listing.rising,
    }.get(sort, listing.hot)
    return sort_method(limit=limit)


def fetch_reddit(config: dict) -> Iterable[tuple[dict, list[str]]]:
    """Fetch Reddit content per the reddit section of sources.json."""
    creds = config.get("credentials", {})
    use_praw = _has_credentials(creds)

    frontpage_cfg = config.get("frontpage", {})
    subreddits = config.get("subreddits", [])

    if use_praw:
        try:
            reddit = _praw_client(creds)
            yield from _fetch_praw(reddit, frontpage_cfg, subreddits, _has_user_auth(creds))
            return
        except Exception as e:
            print(f"[reddit] PRAW failed ({e!r}); falling back to RSS")

    yield from _fetch_rss_fallback(frontpage_cfg, subreddits)


def _fetch_praw(reddit, frontpage_cfg: dict, subreddits: list[dict], personalized: bool):
    if frontpage_cfg.get("enabled", True):
        sort = frontpage_cfg.get("sort", "hot")
        limit = frontpage_cfg.get("limit", 100)
        # Personalized frontpage = reddit.front; logged-out equivalent = r/popular
        listing = reddit.front if personalized else reddit.subreddit("popular")
        try:
            for sub in _iter_listing(listing, sort, limit):
                if getattr(sub, "stickied", False):
                    continue
                yield _submission_to_item(sub, "frontpage"), ["frontpage", "reddit"]
        except Exception as e:
            print(f"[reddit] frontpage fetch failed: {e!r}")

    for sr in subreddits:
        name = sr["name"]
        sort = sr.get("sort", "hot")
        limit = sr.get("limit", 25)
        extra_tags = sr.get("tags", [])
        try:
            for sub in _iter_listing(reddit.subreddit(name), sort, limit):
                if getattr(sub, "stickied", False):
                    continue
                yield _submission_to_item(sub, name), [f"r/{name}", "reddit", *extra_tags]
        except Exception as e:
            print(f"[reddit] r/{name} fetch failed: {e!r}")


def _fetch_rss_fallback(frontpage_cfg: dict, subreddits: list[dict]):
    """Use Reddit's .rss endpoints. Limited to ~25 items, no scores/comments."""
    if frontpage_cfg.get("enabled", True):
        sort = frontpage_cfg.get("sort", "hot")
        url = f"https://www.reddit.com/r/popular/{sort}/.rss"
        for item, _tags in fetch_rss("frontpage", url, []):
            item["source_kind"] = "reddit"
            item["source_name"] = "frontpage"
            yield item, ["frontpage", "reddit"]

    for sr in subreddits:
        name = sr["name"]
        sort = sr.get("sort", "hot")
        extra_tags = sr.get("tags", [])
        url = f"https://www.reddit.com/r/{name}/{sort}/.rss"
        for item, _tags in fetch_rss(name, url, []):
            item["source_kind"] = "reddit"
            item["source_name"] = name
            yield item, [f"r/{name}", "reddit", *extra_tags]
