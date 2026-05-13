"""Launcher modes:

    pyw app.py --tray        # system tray icon, no console (RECOMMENDED)
    py  app.py --web         # serve only, open the URL yourself
    py  app.py               # PyWebView native window (if pywebview is installed)

Tray mode runs the FastAPI server in a background thread, opens the browser
on first launch, and parks an icon in the system tray. Left-click the icon
to re-open the browser; right-click for the menu.
"""

from __future__ import annotations

import argparse
import math
import os
import socket
import sys
import threading
import time
import traceback
import webbrowser
from datetime import datetime
from pathlib import Path


# ---------- stdio redirect for pythonw.exe / pyw.exe ----------
# When launched without a console, sys.stdout/stderr are either None or
# special "discard" streams that some libraries (uvicorn's logging, anyio,
# etc.) crash on. Point them at a real log file BEFORE anything imports
# uvicorn so writes don't blow up the server thread silently.

_USER_CONFIG_DIR = Path.home() / ".constellar"
_LOG_FILE = _USER_CONFIG_DIR / "constellar.log"


def _redirect_stdio_for_no_console():
    """If running under a windowed Python (pythonw/pyw), route stdio to a log file."""
    needs_redirect = (
        sys.stdout is None
        or sys.stderr is None
        or not hasattr(sys.stdout, "fileno")
        or _stdout_is_broken()
    )
    if not needs_redirect:
        return
    _USER_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    log = open(_LOG_FILE, "a", buffering=1, encoding="utf-8")
    log.write(f"\n=== {datetime.now().isoformat()} | console-less Python detected, redirecting stdio ===\n")
    sys.stdout = log
    sys.stderr = log
    try:
        sys.stdin = open(os.devnull, "r")
    except OSError:
        pass


def _stdout_is_broken() -> bool:
    """True if sys.stdout exists but is non-functional (the common pythonw case)."""
    try:
        sys.stdout.fileno()
        return False
    except (OSError, ValueError, AttributeError):
        return True


_redirect_stdio_for_no_console()


# ---------- secrets: load from ~/.constellar/config.env BEFORE backend imports ----------
# The file lives outside the repo so it can't be committed by accident.
# Format: KEY=value, one per line; # for comments; quotes around values are stripped.
# Existing process env vars take precedence — set in your shell to override the file.

USER_CONFIG_DIR = Path.home() / ".constellar"
USER_CONFIG_FILE = USER_CONFIG_DIR / "config.env"


def _load_user_env(path: Path = USER_CONFIG_FILE) -> int:
    """Populate os.environ from the user's config file. Returns count of vars set."""
    if not path.exists():
        return 0
    n = 0
    with path.open(encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            # Strip surrounding quotes if present (single or double).
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            if key and key not in os.environ:
                os.environ[key] = value
                n += 1
    return n


_loaded = _load_user_env()
if _loaded:
    print(f"[constellar] loaded {_loaded} secrets from {USER_CONFIG_FILE}", file=sys.stderr)

# Now safe to import the backend — curator.py / fetch_runner.py will see the env vars.
import uvicorn
from backend.main import app

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5173


def _wait_for_port(host: str, port: int, timeout: float = 12.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.25)
            try:
                s.connect((host, port))
                return True
            except OSError:
                time.sleep(0.1)
    return False


def _serve(host: str, port: int, log_level: str = "info"):
    try:
        uvicorn.run(app, host=host, port=port, log_level=log_level)
    except BaseException:
        # Capture EVERY failure path here — without this, an exception in the
        # server thread under pythonw vanishes silently. Log to the same file
        # stdio is redirected to (above), then re-raise.
        try:
            _USER_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            with _LOG_FILE.open("a", encoding="utf-8") as f:
                f.write(f"\n=== {datetime.now().isoformat()} | server thread crashed ===\n")
                traceback.print_exc(file=f)
        except Exception:
            pass
        raise


def _start_server_thread(host: str, port: int, log_level: str = "info"):
    t = threading.Thread(
        target=_serve, args=(host, port, log_level), daemon=True
    )
    t.start()
    return t


def _open_browser(host: str, port: int):
    webbrowser.open(f"http://{host}:{port}", new=2)


# ---------------- tray mode ----------------

def _make_tray_icon_image():
    """Render a 64x64 star icon programmatically. No external file needed."""
    from PIL import Image, ImageDraw

    size = 64
    img = Image.new("RGBA", (size, size), (10, 10, 16, 0))
    draw = ImageDraw.Draw(img)

    cx = cy = size / 2
    r_outer = 26
    r_inner = 11
    points = []
    for i in range(10):
        angle = -math.pi / 2 + i * math.pi / 5
        radius = r_outer if i % 2 == 0 else r_inner
        points.append((cx + radius * math.cos(angle),
                       cy + radius * math.sin(angle)))
    # Soft outer glow
    for spread, alpha in [(6, 30), (3, 60)]:
        glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(glow).polygon(points, fill=(201, 163, 255, alpha))
        img.alpha_composite(glow)
    # Bright core star
    draw.polygon(points, fill=(201, 163, 255, 255))
    return img


def _run_tray(host: str, port: int):
    try:
        from pystray import Icon, Menu, MenuItem
    except ImportError:
        print("--tray requires pystray. Install with: pip install pystray", file=sys.stderr)
        sys.exit(1)

    # Quiet uvicorn so it doesn't try to write to a non-existent console
    # when launched via pythonw.exe.
    server = _start_server_thread(host, port, log_level="warning")
    if not _wait_for_port(host, port):
        # Fail open — show the icon anyway; clicking will open the browser
        # which will at least surface the connection error.
        pass

    # Open the browser once on first launch.
    _open_browser(host, port)

    def on_open(icon, item):
        _open_browser(host, port)

    def on_refresh(icon, item):
        # Trigger a curate=true refresh in the user's browser tab.
        webbrowser.open(f"http://{host}:{port}", new=0)

    def on_quit(icon, item):
        icon.stop()

    icon = Icon(
        "constellar",
        _make_tray_icon_image(),
        "Constellar",
        menu=Menu(
            MenuItem("Open Constellar", on_open, default=True),
            MenuItem("Reopen browser tab", on_refresh),
            Menu.SEPARATOR,
            MenuItem("Quit", on_quit),
        ),
    )
    icon.run()
    # icon.run() blocks until quit. After it returns, exit cleanly so the
    # daemon server thread is torn down.
    sys.exit(0)


# ---------------- main ----------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tray", action="store_true",
                        help="run in the system tray (recommended; pair with pythonw/pyw to hide console)")
    parser.add_argument("--web", action="store_true",
                        help="serve only, open the URL in your browser yourself")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()

    if args.tray:
        _run_tray(args.host, args.port)
        return

    if args.web:
        _serve(args.host, args.port)
        return

    # Default: try a native window (PyWebView).
    server_thread = _start_server_thread(args.host, args.port)

    if not _wait_for_port(args.host, args.port):
        print("server failed to start on time", file=sys.stderr)
        sys.exit(1)

    try:
        import webview
    except ImportError:
        print("pywebview not installed; falling back to web mode.", file=sys.stderr)
        print(f"open http://{args.host}:{args.port} in your browser.", file=sys.stderr)
        server_thread.join()
        return

    webview.create_window(
        "Constellar",
        f"http://{args.host}:{args.port}",
        width=1400,
        height=900,
        min_size=(900, 600),
    )
    webview.start()


if __name__ == "__main__":
    main()
