from __future__ import annotations

import argparse
import base64
import json
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
import urllib.request
import socket
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

from PIL import Image, ImageStat
import websocket

from smoke_evidence import current_git_commit, write_json


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
ARTIFACTS = ROOT / "artifacts" / "ui-smoke"
EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
OUTBOUND_EVIDENCE_SOURCE = (ROOT / "scripts" / "outbound_evidence.cjs").read_text(
    encoding="utf-8"
)
SMOKE_URL_SUBSCRIPTION = "\n".join(
    [
        "vless://url-test-uuid@url-vless.example.com:443?encryption=none&security=tls&type=ws&sni=url.example.com#Smoke URL VLESS",
        "trojan://url-password@url-trojan.example.com:8443?security=tls&sni=url-trojan.example.com#Smoke URL Trojan",
    ],
)
CDP_DISCOVERY_TIMEOUT_SECONDS = 45.0
CDP_CONNECT_TIMEOUT_SECONDS = 30.0
CDP_COMMAND_TIMEOUT_SECONDS = 20.0
SHELL_READY_TIMEOUT_SECONDS = 30.0
DIAGNOSTIC_LOG_BYTES = 8192
TRAFFIC_SAMPLE_ATTEMPTS = 8
TRAFFIC_SAMPLE_SETTLE_SECONDS = 0.15


class CDPTimeout(RuntimeError):
    pass


class QuietHandler(SimpleHTTPRequestHandler):
    request_counts: dict[str, int] = {}
    request_counts_lock = threading.Lock()

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path in {
            "/generate_204",
            "/smoke-subscription",
            "/smoke-subscription-slow",
            "/smoke-subscription-error",
        }:
            with self.request_counts_lock:
                self.request_counts[path] = self.request_counts.get(path, 0) + 1
        if path == "/generate_204":
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            return
        if path == "/smoke-subscription-error":
            self.send_response(502)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            return
        if path in {"/smoke-subscription", "/smoke-subscription-slow"}:
            if path.endswith("-slow"):
                time.sleep(0.8)
            data = SMOKE_URL_SUBSCRIPTION.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    @classmethod
    def request_count(cls, path: str) -> int:
        with cls.request_counts_lock:
            return cls.request_counts.get(path, 0)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def handle_one_request(self) -> None:
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError):
            return


class CDP:
    def __init__(
        self,
        url: str,
        edge: subprocess.Popen[Any] | None = None,
        validator: Callable[[], None] | None = None,
    ) -> None:
        self.url = url
        self.edge = edge
        self.validator = validator
        self.ws = self._connect()
        self.next_id = 1

    def _connect(self) -> websocket.WebSocket:
        if self.edge is not None:
            ensure_process_alive(self.edge, "CDP WebSocket handshake")
        if self.validator is not None:
            self.validator()
        return websocket.create_connection(self.url, timeout=10)

    def reconnect(self) -> None:
        try:
            self.ws.close()
        except Exception:
            pass
        self.ws = self._connect()

    def close(self) -> None:
        self.ws.close()

    def call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = CDP_COMMAND_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        if self.edge is not None:
            ensure_process_alive(self.edge, f"CDP {method}")
        message_id = self.next_id
        self.next_id += 1
        self.ws.send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CDPTimeout(f"CDP {method} exceeded {timeout:.1f}s")
            self.ws.settimeout(max(0.1, remaining))
            try:
                raw = self.ws.recv()
            except websocket.WebSocketTimeoutException as error:
                raise CDPTimeout(f"CDP {method} exceeded {timeout:.1f}s") from error
            payload = json.loads(raw)
            if payload.get("id") != message_id:
                continue
            if "error" in payload:
                raise RuntimeError(f"{method}: {payload['error']}")
            return payload.get("result", {})

    def evaluate(
        self,
        expression: str,
        *,
        await_promise: bool = False,
        timeout: float = CDP_COMMAND_TIMEOUT_SECONDS,
    ) -> Any:
        result = self.call(
            "Runtime.evaluate",
            {
                "awaitPromise": await_promise,
                "expression": expression,
                "returnByValue": True,
            },
            timeout=timeout,
        )
        if "exceptionDetails" in result:
            raise RuntimeError(json.dumps(result["exceptionDetails"], ensure_ascii=False))
        return result.get("result", {}).get("value")

    def screenshot(self, path: Path) -> None:
        data = self.call(
            "Page.captureScreenshot",
            {"captureBeyondViewport": False, "format": "png", "fromSurface": True},
        )["data"]
        path.write_bytes(base64.b64decode(data))
        assert_nonblank_png(path)


def assert_nonblank_png(path: Path) -> None:
    with Image.open(path) as image:
        stat = ImageStat.Stat(image.convert("RGB"))
        spread = sum(max(channel) - min(channel) for channel in stat.extrema)
        if image.width < 100 or image.height < 100 or spread < 30:
            raise AssertionError(f"screenshot looks blank: {path}")


def free_port() -> int:
    """Compatibility helper for native smoke runners that cannot use port zero."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def start_server(port: int) -> ThreadingHTTPServer:
    if not DIST.is_dir():
        raise RuntimeError(f"dist directory not found: {DIST}")

    def handler(*args: Any, **kwargs: Any) -> QuietHandler:
        return QuietHandler(*args, directory=str(DIST), **kwargs)

    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def read_json(url: str, timeout: float = 2.0) -> Any:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_json(url: str, timeout: float = 10.0) -> Any:
    """Compatibility helper for native smoke runners."""
    deadline = time.monotonic() + timeout
    delay = 0.05
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            return read_json(url)
        except Exception as error:  # noqa: BLE001 - bounded readiness retry.
            last_error = error
            time.sleep(delay)
            delay = min(delay * 1.7, 1.0)
    raise RuntimeError(f"timed out waiting for local endpoint: {last_error}")


def ensure_process_alive(edge: subprocess.Popen[str], phase: str) -> None:
    if edge.poll() is not None:
        raise RuntimeError(f"Edge exited during {phase} (exit code {edge.returncode})")


def parse_devtools_active_port(path: Path) -> tuple[int, str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    if len(lines) < 2:
        raise RuntimeError("DevToolsActivePort is incomplete")
    port = int(lines[0])
    browser_path = lines[1].strip()
    if not 1 <= port <= 65535 or not browser_path.startswith("/devtools/browser/"):
        raise RuntimeError("DevToolsActivePort is invalid")
    return port, browser_path


def validate_websocket_endpoint(url: str, port: int, expected_path: str | None = None) -> None:
    parsed = urlparse(url)
    if (
        parsed.scheme != "ws"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or parsed.port != port
        or (expected_path is not None and parsed.path != expected_path)
    ):
        raise RuntimeError("CDP endpoint does not belong to the reserved Edge profile")


def wait_edge_endpoint(
    edge: subprocess.Popen[str],
    user_dir: Path,
    expected_page_url: str,
    timeout: float = CDP_DISCOVERY_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    delay = 0.05
    last_error: Exception | None = None
    active_port_path = user_dir / "DevToolsActivePort"
    while time.monotonic() < deadline:
        ensure_process_alive(edge, "CDP endpoint discovery")
        try:
            port, browser_path = parse_devtools_active_port(active_port_path)
            version = read_json(f"http://127.0.0.1:{port}/json/version")
            browser_ws = str(version.get("webSocketDebuggerUrl", ""))
            validate_websocket_endpoint(browser_ws, port, browser_path)
            tabs = read_json(f"http://127.0.0.1:{port}/json/list")
            page = next(
                item
                for item in tabs
                if item.get("type") == "page"
                and str(item.get("url", "")).startswith(expected_page_url)
            )
            page_ws = str(page.get("webSocketDebuggerUrl", ""))
            validate_websocket_endpoint(page_ws, port)
            return {
                "port": port,
                "browser": str(version.get("Browser", "unknown"))[:120],
                "browserWebSocketUrl": browser_ws,
                "pageWebSocketUrl": page_ws,
                "pageUrl": str(page.get("url", ""))[:300],
                "ownership": "exclusive-profile-ready-file",
            }
        except Exception as error:  # noqa: BLE001 - bounded discovery retry.
            last_error = error
            time.sleep(delay)
            delay = min(delay * 1.7, 1.0)
    raise RuntimeError(f"CDP endpoint discovery timed out after {timeout:.1f}s: {last_error}")


def connect_cdp(
    edge: subprocess.Popen[str],
    endpoint: dict[str, Any],
    timeout: float = CDP_CONNECT_TIMEOUT_SECONDS,
) -> CDP:
    deadline = time.monotonic() + timeout
    delay = 0.05
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        ensure_process_alive(edge, "CDP WebSocket connection")
        try:
            port = int(endpoint["port"])

            def validate_owner() -> None:
                ensure_process_alive(edge, "CDP endpoint ownership check")
                version = read_json(f"http://127.0.0.1:{port}/json/version")
                browser_ws = str(version.get("webSocketDebuggerUrl", ""))
                validate_websocket_endpoint(browser_ws, port)
                if browser_ws != endpoint["browserWebSocketUrl"]:
                    raise RuntimeError("CDP browser endpoint identity changed")
                tabs = read_json(f"http://127.0.0.1:{port}/json/list")
                if not any(
                    item.get("type") == "page"
                    and item.get("webSocketDebuggerUrl") == endpoint["pageWebSocketUrl"]
                    for item in tabs
                ):
                    raise RuntimeError("CDP page endpoint is no longer owned by the Edge process")

            return CDP(str(endpoint["pageWebSocketUrl"]), edge, validate_owner)
        except Exception as error:  # noqa: BLE001 - bounded handshake retry.
            last_error = error
            time.sleep(delay)
            delay = min(delay * 1.7, 1.0)
    raise RuntimeError(f"CDP WebSocket handshake timed out after {timeout:.1f}s: {last_error}")


def sanitize_diagnostic_text(value: str) -> str:
    text = value[-DIAGNOSTIC_LOG_BYTES:]
    text = re.sub(r"(?i)bearer\s+[a-z0-9._~+/=-]+", "Bearer <redacted>", text)
    text = re.sub(
        r"(?i)(token|password|passwd|psk|authorization|secret)(\s*[:=]\s*)([^\s,;]+)",
        r"\1\2<redacted>",
        text,
    )
    text = re.sub(r"(://)[^/@\s]+@", r"\1<redacted>@", text)
    text = re.sub(r"([?&](?:token|password|psk|auth|secret)=)[^&#\s]+", r"\1<redacted>", text, flags=re.IGNORECASE)
    return text


def read_log_tail(path: Path) -> str:
    try:
        data = path.read_bytes()
        return sanitize_diagnostic_text(data[-DIAGNOSTIC_LOG_BYTES:].decode("utf-8", "replace"))
    except FileNotFoundError:
        return "(log file absent)"
    except Exception as error:  # noqa: BLE001 - best-effort diagnostics.
        return f"(log read failed: {type(error).__name__})"


def port_accepting_connections(port: int | None) -> bool:
    if port is None:
        return False
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except OSError:
        return False


def wait_port_released(port: int | None, timeout: float = 10.0) -> bool:
    if port is None:
        return True
    deadline = time.monotonic() + timeout
    delay = 0.05
    while time.monotonic() < deadline:
        if not port_accepting_connections(port):
            return True
        time.sleep(delay)
        delay = min(delay * 1.7, 0.75)
    return not port_accepting_connections(port)


def stop_process_tree(process: subprocess.Popen[Any], timeout: float = 10.0) -> None:
    if process.poll() is not None:
        process.wait(timeout=1)
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        if os.name != "nt":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()
        process.wait(timeout=5)


def stop_edge(edge: subprocess.Popen[Any]) -> None:
    stop_process_tree(edge)


def page_text(cdp: CDP) -> str:
    return str(cdp.evaluate("document.body.innerText"))


def wait_for_shell(cdp: CDP) -> str:
    deadline = time.monotonic() + SHELL_READY_TIMEOUT_SECONDS
    delay = 0.05
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            state = cdp.evaluate(
                """
                (() => ({
                  ready: Boolean(document.querySelector('.prism-shell')),
                  text: document.body?.innerText ?? '',
                  documentState: document.readyState
                }))()
                """,
                timeout=3.0,
            )
            if state and state.get("ready"):
                return str(state.get("text", ""))
        except (CDPTimeout, OSError, RuntimeError, websocket.WebSocketException) as error:
            last_error = error
            try:
                cdp.reconnect()
                cdp.call("Runtime.enable", timeout=5.0)
                cdp.call("Page.enable", timeout=5.0)
                set_viewport(cdp, 800, 540)
            except Exception as reconnect_error:  # noqa: BLE001 - bounded recovery loop.
                last_error = reconnect_error
        time.sleep(delay)
        delay = min(delay * 1.7, 1.0)
    detail = type(last_error).__name__ if last_error is not None else "shell marker absent"
    raise RuntimeError(
        f"shell did not become ready within {SHELL_READY_TIMEOUT_SECONDS:.1f}s ({detail})"
    )


def navigate_hash(cdp: CDP, view: str) -> str:
    return str(
        cdp.evaluate(
            f"""
            new Promise((resolve) => {{
              location.hash = '{view}';
              setTimeout(() => resolve(document.body.innerText), 350);
            }})
            """,
            await_promise=True,
        ),
    )


def set_viewport(cdp: CDP, width: int, height: int) -> None:
    cdp.call(
        "Emulation.setDeviceMetricsOverride",
        {
            "deviceScaleFactor": 1,
            "height": height,
            "mobile": width < 600,
            "width": width,
        },
    )


def assert_contains(text: str, *needles: str) -> None:
    missing = [needle for needle in needles if needle not in text]
    if missing:
        raise AssertionError(f"missing text: {missing}\n--- page text ---\n{text[:1600]}")


def assert_contains_any(text: str, *needles: str) -> None:
    if not any(needle in text for needle in needles):
        raise AssertionError(f"missing any text: {needles}\n--- page text ---\n{text[:1600]}")


def assert_not_contains(text: str, *needles: str) -> None:
    found = [needle for needle in needles if needle in text]
    if found:
        raise AssertionError(f"unexpected text: {found}\n--- page text ---\n{text[:1600]}")


def assert_no_runtime_error(text: str) -> None:
    forbidden = [
        "Cannot read properties",
        "Tauri runtime is unavailable",
        "ERR_CONNECTION_REFUSED",
        "This page isn't working",
    ]
    found = [needle for needle in forbidden if needle in text]
    if found:
        raise AssertionError(f"unexpected runtime error text: {found}")


def assert_no_horizontal_overflow(cdp: CDP) -> None:
    overflow = cdp.evaluate(
        """
        (() => ({
          body: document.body.scrollWidth,
          html: document.documentElement.scrollWidth,
          width: window.innerWidth
        }))()
        """,
    )
    width = int(overflow["width"])
    if int(overflow["body"]) > width + 2 or int(overflow["html"]) > width + 2:
        raise AssertionError(f"horizontal overflow detected: {overflow}")


def assert_content_fits_viewport(cdp: CDP) -> None:
    overflow = cdp.evaluate(
        """
        (() => {
          const content = document.querySelector('.prism-content');
          return {
            client: content?.clientHeight ?? 0,
            scroll: content?.scrollHeight ?? 0,
            window: window.innerHeight
          };
        })()
        """,
    )
    if int(overflow["scroll"]) > int(overflow["client"]):
        raise AssertionError(f"content vertical overflow detected: {overflow}")


def assert_no_shell_overflow(cdp: CDP, page: str) -> None:
    overflow = cdp.evaluate(
        """
        (() => {
          const html = document.documentElement;
          const body = document.body;
          const shell = document.querySelector('.prism-shell');
          const shellRect = shell?.getBoundingClientRect();
          return {
            bodyClientHeight: body.clientHeight,
            bodyClientWidth: body.clientWidth,
            bodyScrollHeight: body.scrollHeight,
            bodyScrollWidth: body.scrollWidth,
            htmlClientHeight: html.clientHeight,
            htmlClientWidth: html.clientWidth,
            htmlScrollHeight: html.scrollHeight,
            htmlScrollWidth: html.scrollWidth,
            shellBottom: shellRect ? Math.round(shellRect.bottom) : -1,
            shellRight: shellRect ? Math.round(shellRect.right) : -1,
            windowHeight: window.innerHeight,
            windowWidth: window.innerWidth
          };
        })()
        """,
    )
    width = int(overflow["windowWidth"])
    height = int(overflow["windowHeight"])
    escaped = (
        int(overflow["bodyScrollWidth"]) > int(overflow["bodyClientWidth"])
        or int(overflow["htmlScrollWidth"]) > int(overflow["htmlClientWidth"])
        or int(overflow["bodyScrollHeight"]) > height
        or int(overflow["htmlScrollHeight"]) > height
        or int(overflow["shellRight"]) > width
        or int(overflow["shellBottom"]) > height
    )
    if escaped:
        raise AssertionError(f"{page} escaped the desktop shell: {overflow}")


def assert_content_scroll_is_contained(cdp: CDP) -> None:
    scroll = cdp.evaluate(
        """
        (() => {
          const content = document.querySelector('.prism-content');
          return {
            body: document.body.scrollHeight,
            contentClient: content?.clientHeight ?? 0,
            contentOverflowY: content ? getComputedStyle(content).overflowY : '',
            window: window.innerHeight
          };
        })()
        """,
    )
    if int(scroll["body"]) > int(scroll["window"]) + 2:
        raise AssertionError(f"page scroll escaped the desktop shell: {scroll}")
    if int(scroll["contentClient"]) <= 0 or scroll["contentOverflowY"] != "auto":
        raise AssertionError(f"content scroll container is not configured: {scroll}")


def assert_fixed_window_labels_fit(cdp: CDP, page: str) -> None:
    fit = cdp.evaluate(
        f"""
        (() => {{
          const page = {json.dumps(page)};
          const clipped = Array.from(
            document.querySelectorAll('.capability-pill strong, .core-switch strong')
          ).filter((item) => item.scrollWidth > item.clientWidth + 1)
            .map((item) => item.textContent.trim());
          return {{ clipped }};
        }})()
        """,
    )
    if fit["clipped"]:
        raise AssertionError(f"fixed-window quick labels are clipped: {fit}")


def assert_desktop_viewport(cdp: CDP) -> None:
    assert_viewport(cdp, 800, 540)


def assert_viewport(cdp: CDP, width: int, height: int) -> None:
    viewport = cdp.evaluate(
        """
        (() => ({
          width: window.innerWidth,
          height: window.innerHeight,
          shellWidth: Math.round(document.querySelector('.prism-shell')?.getBoundingClientRect().width ?? 0),
          shellHeight: Math.round(document.querySelector('.prism-shell')?.getBoundingClientRect().height ?? 0)
        }))()
        """,
    )
    if int(viewport["width"]) != width or int(viewport["height"]) != height:
        raise AssertionError(f"desktop viewport changed unexpectedly: {viewport}")
    if int(viewport["shellWidth"]) < width - 10 or int(viewport["shellHeight"]) < height - 10:
        raise AssertionError(f"desktop shell is not filling the viewport: {viewport}")


def assert_custom_window_chrome(cdp: CDP) -> None:
    chrome = cdp.evaluate(
        """
        (() => ({
          titlebar: Boolean(document.querySelector('.app-titlebar')),
          dragRegions: document.querySelectorAll('[data-tauri-drag-region]').length,
          actionCount: document.querySelectorAll('.window-actions button').length,
          actions: Array.from(document.querySelectorAll('.window-actions button'))
            .map((button) => button.dataset.windowAction),
          labelsPresent: Array.from(document.querySelectorAll('.window-actions button'))
            .every((button) => Boolean(button.getAttribute('aria-label')))
        }))()
        """,
    )
    if not chrome["titlebar"] or int(chrome["dragRegions"]) < 2 or int(chrome["actionCount"]) != 4:
        raise AssertionError(f"custom window chrome missing: {chrome}")
    expected = {"pin", "minimize", "maximize", "close"}
    if set(chrome["actions"]) != expected or not chrome["labelsPresent"]:
        raise AssertionError(f"custom window controls mismatch: {chrome}")


def assert_desktop_interaction_polish(cdp: CDP) -> None:
    polish = cdp.evaluate(
        """
        (() => {
          const hasScrollbarRule = () => {
            for (const sheet of Array.from(document.styleSheets)) {
              let rules = [];
              try {
                rules = Array.from(sheet.cssRules ?? []);
              } catch {
                continue;
              }
              if (rules.some((rule) => String(rule.selectorText ?? '').includes('::-webkit-scrollbar-thumb'))) {
                return true;
              }
            }
            return false;
          };
          const titlebar = document.querySelector('.app-titlebar');
          const button = document.querySelector('.window-actions button');
          const input = document.querySelector('input, textarea');
          return {
            bodyUserSelect: getComputedStyle(document.body).userSelect,
            inputUserSelect: input ? getComputedStyle(input).userSelect : '',
            dragRegionCount: document.querySelectorAll('[data-tauri-drag-region]').length,
            buttonBlockedFromDrag: Boolean(button?.closest('[data-no-window-drag], button')),
            hasScrollbarRule: hasScrollbarRule()
          };
        })()
        """,
    )
    if polish["bodyUserSelect"] != "none":
        raise AssertionError(f"body text selection is not disabled: {polish}")
    if polish["inputUserSelect"] and polish["inputUserSelect"] != "text":
        raise AssertionError(f"form text selection is not enabled: {polish}")
    if int(polish["dragRegionCount"]) < 2 or not polish["buttonBlockedFromDrag"]:
        raise AssertionError(f"custom window drag regions are not wired correctly: {polish}")
    if not polish["hasScrollbarRule"]:
        raise AssertionError(f"custom scrollbar style rule missing: {polish}")


def inject_dual_core_traffic(cdp: CDP) -> dict[str, int]:
    return cdp.evaluate(
        """
        (() => {
          const previous = window.__tachyonPrismTrafficFixture ?? {
            sequence: 0,
            tachyonUp: 1000,
            tachyonDown: 2000,
            xrayUp: 3000,
            xrayDown: 4000
          };
          const next = previous.sequence === 0 ? previous : {
            sequence: previous.sequence,
            tachyonUp: previous.tachyonUp + 6000,
            tachyonDown: previous.tachyonDown + 8000,
            xrayUp: previous.xrayUp + 11000,
            xrayDown: previous.xrayDown + 15000
          };
          next.sequence += 1;
          window.__tachyonPrismTrafficFixture = next;
          window.dispatchEvent(new CustomEvent('tachyon-prism:test-traffic', {
            detail: {
              tachyonUp: next.tachyonUp,
              tachyonDown: next.tachyonDown,
              xrayUp: next.xrayUp,
              xrayDown: next.xrayDown
            }
          }));
          return next;
        })()
        """,
    )


def dual_core_chart_snapshot(cdp: CDP) -> dict[str, Any]:
    return cdp.evaluate(
        """
        (() => ({
          legend: Array.from(document.querySelectorAll('.legend-item'))
            .map((item) => item.textContent.trim()),
          emptyText: document.querySelector('.chart-empty')?.textContent.trim() ?? '',
          seriesClasses: Array.from(document.querySelectorAll('.legend-item'))
            .map((item) => item.className),
          rates: Array.from(document.querySelectorAll('.legend-item b'))
            .map((item) => item.textContent.trim()),
          points: Array.from(document.querySelectorAll('.traffic-line'))
            .map((item) => item.getAttribute('points') ?? '')
        }))()
        """,
    )


def assert_dual_core_chart(cdp: CDP) -> None:
    attempts: list[dict[str, Any]] = []
    chart: dict[str, Any] = {}
    for attempt in range(1, TRAFFIC_SAMPLE_ATTEMPTS + 1):
        sent = inject_dual_core_traffic(cdp)
        time.sleep(TRAFFIC_SAMPLE_SETTLE_SECONDS)
        chart = dual_core_chart_snapshot(cdp)
        attempts.append({"attempt": attempt, "sent": sent, "chart": chart})
        if (
            len(chart["rates"]) == 4
            and not chart["emptyText"]
            and all(not rate.startswith("0 ") for rate in chart["rates"])
        ):
            break

    labels = " ".join(chart["legend"])
    if len(chart["legend"]) != 4:
        raise AssertionError(f"dual-core traffic chart must expose four series: {chart}")
    for label in ["Tachyon ↑", "Tachyon ↓", "Xray ↑", "Xray ↓"]:
        if label not in labels:
            raise AssertionError(f"dual-core traffic legend missing {label}: {chart}")
    for class_name in ["tachyon-up", "tachyon-down", "xray-up", "xray-down"]:
        if not any(class_name in item for item in chart["seriesClasses"]):
            raise AssertionError(f"dual-core traffic class missing {class_name}: {chart}")
    if chart["emptyText"]:
        raise AssertionError(f"chart stayed in empty state after non-zero injection: {chart}")
    if len(chart["points"]) != 4 or any(not points for points in chart["points"]):
        raise AssertionError(f"four real SVG traffic lines were not rendered: {chart}")
    if any(rate.startswith("0 ") for rate in chart["rates"]):
        raise AssertionError(
            "dual-core rates did not become non-zero after bounded monotonic telemetry "
            f"samples: {attempts}"
        )


def assert_visible_custom_scrollbar(cdp: CDP) -> None:
    result = cdp.evaluate(
        """
        (() => {
          const content = document.querySelector('.prism-content');
          if (!content) return null;
          content.scrollTop = Math.max(1, content.scrollHeight - content.clientHeight);
          const style = getComputedStyle(content);
          return {
            clientHeight: content.clientHeight,
            scrollHeight: content.scrollHeight,
            scrollTop: content.scrollTop,
            overflowY: style.overflowY,
            scrollbarColor: style.scrollbarColor
          };
        })()
        """,
    )
    if not result or result["scrollHeight"] <= result["clientHeight"]:
        raise AssertionError(f"long settings page did not expose a scrollbar: {result}")
    if result["scrollTop"] <= 0 or result["overflowY"] != "auto":
        raise AssertionError(f"settings scrollbar is not interactive: {result}")
    if result["scrollbarColor"] in ("auto", ""):
        raise AssertionError(f"custom scrollbar color is not visible: {result}")


def import_sample_subscription(cdp: CDP) -> str:
    sample = "\n".join(
        [
            "vless://test-uuid@example.com:443?encryption=none&security=reality&type=tcp&sni=www.cloudflare.com&fp=chrome&pbk=public-key&sid=01#Smoke VLESS",
            "trojan://password@example.org:443?security=tls&sni=example.org#Smoke Trojan",
            "hysteria2://secret@example.net:443?sni=game.example.net&insecure=1#Smoke Hysteria",
        ],
    )
    return import_subscription_payload(cdp, "Smoke", sample)


def import_clash_subscription(cdp: CDP) -> str:
    sample = """
proxies:
  - name: Clash Smoke VLESS
    type: vless
    server: clash-vless.example.com
    port: 443
    uuid: clash-vless-uuid
    network: ws
    tls: true
    servername: www.cloudflare.com
    ws-opts:
      path: /ws
      headers:
        Host: cdn.example.com
  - name: Clash Smoke SS
    type: ss
    server: clash-ss.example.com
    port: 8388
    cipher: 2022-blake3-aes-128-gcm
    password: ss-secret
"""
    return import_subscription_payload(cdp, "Clash Smoke", sample)


def import_subscription_payload(cdp: CDP, name: str, payload: str) -> str:
    return str(
        cdp.evaluate(
            f"""
            new Promise((resolve) => {{
              const setValue = (element, value) => {{
                if (!element) throw new Error('subscription form element missing');
                const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
                descriptor.set.call(element, value);
                element.dispatchEvent(new Event('input', {{ bubbles: true }}));
              }};
              const card = document.querySelector('.add-sub-card');
              if (!card) throw new Error('subscription add card missing');
              const inputs = card.querySelectorAll('input');
              setValue(inputs[0], {json.dumps(name)});
              setValue(inputs[1], '');
              setValue(card.querySelector('textarea'), {json.dumps(payload)});
              const button = card.querySelector('.row-actions button:last-child');
              if (!button) throw new Error('import button missing');
              button.click();
              setTimeout(() => resolve(document.body.innerText), 600);
            }})
            """,
            await_promise=True,
        ),
    )


def update_subscription_url(cdp: CDP, name: str, source_url: str) -> str:
    return str(
        cdp.evaluate(
            f"""
            new Promise((resolve) => {{
              const setValue = (element, value) => {{
                if (!element) throw new Error('subscription form element missing');
                const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
                descriptor.set.call(element, value);
                element.dispatchEvent(new Event('input', {{ bubbles: true }}));
              }};
              const card = document.querySelector('.add-sub-card');
              if (!card) throw new Error('subscription add card missing');
              const inputs = card.querySelectorAll('input');
              setValue(inputs[0], {json.dumps(name)});
              setValue(inputs[1], {json.dumps(source_url)});
              setValue(card.querySelector('textarea'), '');
              const button = card.querySelector('.row-actions button:first-child');
              if (!button) throw new Error('update button missing');
              setTimeout(() => {{
                button.click();
                setTimeout(() => resolve(document.body.innerText), 1000);
              }}, 50);
            }})
            """,
            await_promise=True,
        ),
    )


def update_all_subscriptions(cdp: CDP) -> str:
    return str(
        cdp.evaluate(
            """
            new Promise((resolve) => {
              location.hash = 'subscriptions';
              setTimeout(() => {
                const button = Array.from(document.querySelectorAll('.section-toolbar .toolbar-actions button')).find((item) =>
                  item.textContent.trim() === '更新全部' || item.textContent.trim() === 'Update All'
                );
                if (!button) throw new Error('update all subscription button missing');
                button.click();
                setTimeout(() => resolve(document.body.innerText), 1200);
              }, 350);
            })
            """,
            await_promise=True,
        ),
    )


def set_subscription_form(cdp: CDP, name: str | None = None, source_url: str | None = None) -> None:
    cdp.evaluate(
        f"""
        (() => {{
          const card = document.querySelector('.add-sub-card');
          if (!card) throw new Error('subscription add card missing');
          const inputs = card.querySelectorAll('input');
          const setValue = (element, value) => {{
            const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
            descriptor.set.call(element, value);
            element.dispatchEvent(new Event('input', {{ bubbles: true }}));
          }};
          const name = {json.dumps(name)};
          const sourceUrl = {json.dumps(source_url)};
          if (name !== null) setValue(inputs[0], name);
          if (sourceUrl !== null) setValue(inputs[1], sourceUrl);
        }})()
        """,
    )


def subscription_interaction_state(cdp: CDP) -> dict[str, Any]:
    return cdp.evaluate(
        """
        (() => {
          const card = document.querySelector('.add-sub-card');
          const inputs = card?.querySelectorAll('input') ?? [];
          const update = document.querySelector('[data-testid="subscription-update"]');
          const updateAll = document.querySelector('[data-testid="subscription-update-all"]');
          return {
            nameInvalid: inputs[0]?.getAttribute('aria-invalid') === 'true',
            urlInvalid: inputs[1]?.getAttribute('aria-invalid') === 'true',
            updateDisabled: Boolean(update?.disabled),
            updateText: update?.textContent?.trim() ?? '',
            updateAllDisabled: Boolean(updateAll?.disabled),
            updateAllText: updateAll?.textContent?.trim() ?? '',
            fieldErrors: Array.from(card?.querySelectorAll('[role="alert"]') ?? [])
              .map((item) => item.textContent?.trim() ?? ''),
            operationError: document.querySelector('[data-testid="subscription-operation-error"]')
              ?.textContent?.trim() ?? '',
            emptyGroups: document.querySelector('.subscription-groups-empty')?.textContent?.trim() ?? ''
          };
        })()
        """,
    )


def wait_for_subscription_idle(cdp: CDP, timeout_ms: int = 4000) -> dict[str, Any]:
    return cdp.evaluate(
        f"""
        new Promise((resolve, reject) => {{
          const deadline = Date.now() + {timeout_ms};
          const poll = () => {{
            const update = document.querySelector('[data-testid="subscription-update"]');
            const updateAll = document.querySelector('[data-testid="subscription-update-all"]');
            if (update && updateAll && !update.disabled && !updateAll.disabled) {{
              resolve({{
                text: document.body.innerText,
                operationError: document.querySelector('[data-testid="subscription-operation-error"]')
                  ?.textContent?.trim() ?? '',
                fieldErrors: Array.from(document.querySelectorAll('.add-sub-card [role="alert"]'))
                  .map((item) => item.textContent?.trim() ?? '')
              }});
              return;
            }}
            if (Date.now() >= deadline) {{
              reject(new Error('subscription operation did not become idle'));
              return;
            }}
            setTimeout(poll, 50);
          }};
          poll();
        }})
        """,
        await_promise=True,
    )


def switch_to_chinese(cdp: CDP) -> str:
    return str(
        cdp.evaluate(
            """
            new Promise((resolve) => {
              const button = document.querySelector('.settings-card .segmented button:first-child');
              if (!button) throw new Error('Chinese language button missing');
              button.click();
              setTimeout(() => resolve(document.body.innerText), 450);
            })
            """,
            await_promise=True,
        ),
    )


def assert_subscription_interaction_contract(cdp: CDP, port: int) -> str:
    text = navigate_hash(cdp, "subscriptions")
    state = subscription_interaction_state(cdp)
    if not state["emptyGroups"]:
        raise AssertionError(f"empty subscription-group state missing: {state}")

    cdp.evaluate("document.querySelector('[data-testid=\"subscription-update\"]')?.click()")
    time.sleep(0.15)
    state = subscription_interaction_state(cdp)
    if not state["nameInvalid"] or not state["urlInvalid"] or len(state["fieldErrors"]) != 2:
        raise AssertionError(f"subscription fields were not validated independently: {state}")

    set_subscription_form(cdp, name="Smoke URL")
    state = subscription_interaction_state(cdp)
    if state["nameInvalid"] or not state["urlInvalid"]:
        raise AssertionError(f"editing the name did not clear only the name error: {state}")

    slow_path = "/smoke-subscription-slow"
    set_subscription_form(cdp, source_url=f"http://127.0.0.1:{port}{slow_path}")
    before_single = QuietHandler.request_count(slow_path)
    cdp.evaluate(
        """
        (() => {
          const button = document.querySelector('[data-testid="subscription-update"]');
          button?.click();
          button?.click();
        })()
        """,
    )
    time.sleep(0.15)
    state = subscription_interaction_state(cdp)
    if not state["updateDisabled"] or not state["updateAllDisabled"]:
        raise AssertionError(f"single subscription pending state did not lock both actions: {state}")
    if "正在更新" not in state["updateText"]:
        raise AssertionError(f"single subscription pending label is not localized: {state}")
    idle = wait_for_subscription_idle(cdp)
    if QuietHandler.request_count(slow_path) - before_single != 1:
        raise AssertionError("single subscription double click issued more than one request")
    assert_contains(str(idle["text"]), "Smoke URL VLESS", "Smoke URL Trojan")

    error_path = "/smoke-subscription-error"
    set_subscription_form(cdp, source_url=f"http://127.0.0.1:{port}{error_path}")
    cdp.evaluate("document.querySelector('[data-testid=\"subscription-update\"]')?.click()")
    idle = wait_for_subscription_idle(cdp)
    state = subscription_interaction_state(cdp)
    if state["nameInvalid"] or not state["urlInvalid"]:
        raise AssertionError(f"fetch failure was not attached only to the URL field: {state}")
    if not any("订阅获取失败" in item for item in state["fieldErrors"]):
        raise AssertionError(f"Chinese subscription error is not local to the form: {state}")

    navigate_hash(cdp, "settings")
    select_settings_section(cdp, 0)
    switch_to_english(cdp)
    navigate_hash(cdp, "subscriptions")
    state = subscription_interaction_state(cdp)
    if not any("Could not fetch the subscription" in item for item in state["fieldErrors"]):
        raise AssertionError(f"subscription error did not relocalize to English: {state}")

    set_subscription_form(cdp, source_url=f"http://127.0.0.1:{port}{slow_path}")
    state = subscription_interaction_state(cdp)
    if state["urlInvalid"] or state["fieldErrors"]:
        raise AssertionError(f"editing the URL did not clear its local error: {state}")

    before_batch = QuietHandler.request_count(slow_path)
    cdp.evaluate(
        """
        (() => {
          const button = document.querySelector('[data-testid="subscription-update-all"]');
          button?.click();
          button?.click();
        })()
        """,
    )
    time.sleep(0.15)
    state = subscription_interaction_state(cdp)
    if not state["updateDisabled"] or not state["updateAllDisabled"]:
        raise AssertionError(f"batch subscription pending state did not lock both actions: {state}")
    if "Updating all" not in state["updateAllText"]:
        raise AssertionError(f"batch subscription pending label is not localized: {state}")
    idle = wait_for_subscription_idle(cdp)
    if QuietHandler.request_count(slow_path) - before_batch != 1:
        raise AssertionError("batch subscription double click issued more than one request")
    if idle["operationError"]:
        raise AssertionError(f"successful batch update left a local error: {idle}")

    navigate_hash(cdp, "settings")
    select_settings_section(cdp, 0)
    switch_to_chinese(cdp)
    return navigate_hash(cdp, "subscriptions")


def click_add_subscription(cdp: CDP) -> dict[str, Any]:
    return cdp.evaluate(
        """
        new Promise((resolve) => {
          location.hash = 'subscriptions';
          setTimeout(() => {
            const add = document.querySelector('.section-toolbar .primary-action');
            if (!add) throw new Error('top add subscription button missing');
            add.click();
            setTimeout(() => resolve({
              activeTag: document.activeElement?.tagName ?? '',
              activePlaceholder: document.activeElement?.getAttribute('placeholder') ?? '',
              text: document.body.innerText
            }), 350);
          }, 350);
        })
        """,
        await_promise=True,
    )


def choose_node(cdp: CDP, node_name: str) -> str:
    return str(
        cdp.evaluate(
            f"""
            new Promise((resolve) => {{
              const node = Array.from(document.querySelectorAll('.node-tile')).find((item) =>
                item.textContent.includes({json.dumps(node_name)})
              );
              if (!node) throw new Error('node tile not found: ' + {json.dumps(node_name)});
              node.click();
              setTimeout(() => resolve(document.body.innerText), 400);
            }})
            """,
            await_promise=True,
        ),
    )


def choose_subscription(cdp: CDP, subscription_name: str) -> str:
    return str(
        cdp.evaluate(
            f"""
            new Promise((resolve) => {{
              const card = Array.from(document.querySelectorAll('.subscription-card')).find((item) =>
                item.querySelector('strong')?.textContent?.trim() === {json.dumps(subscription_name)}
              );
              const button = card?.querySelector('button');
              if (!button) throw new Error('subscription card not found: ' + {json.dumps(subscription_name)});
              button.click();
              setTimeout(() => resolve(document.body.innerText), 400);
            }})
            """,
            await_promise=True,
        ),
    )


def assert_selected_subscription_persisted(
    cdp: CDP,
    subscription_name: str,
    node_name: str,
) -> None:
    cdp.call("Page.reload", {"ignoreCache": True})
    wait_for_shell(cdp)
    navigate_hash(cdp, "subscriptions")
    selection = cdp.evaluate(
        """
        (() => ({
          subscription: document.querySelector('.subscription-card.active strong')?.textContent?.trim() ?? '',
          node: document.querySelector('.node-tile.active strong')?.textContent?.trim() ?? ''
        }))()
        """,
    )
    expected = {"subscription": subscription_name, "node": node_name}
    if selection != expected:
        raise AssertionError(f"subscription selection was not persisted: {selection}")


def switch_routing_mode(cdp: CDP, mode: str) -> str:
    return str(
        cdp.evaluate(
            f"""
            new Promise((resolve) => {{
              location.hash = 'overview';
              setTimeout(() => {{
                const button = document.querySelector('[data-routing-mode="{mode}"]');
                if (!button) throw new Error('routing mode button missing: {mode}');
                button.click();
                setTimeout(() => resolve(document.body.innerText), 350);
              }}, 350);
            }})
            """,
            await_promise=True,
        ),
    )


def active_routing_mode(cdp: CDP) -> str:
    return str(
        cdp.evaluate(
            "document.querySelector('.work-mode-list .mode-option.active')?.dataset.routingMode ?? ''",
        ),
    )


def xray_routing_summary(cdp: CDP) -> dict[str, Any]:
    cdp.evaluate(OUTBOUND_EVIDENCE_SOURCE)
    return cdp.evaluate(
        r"""
        new Promise((resolve) => {
          location.hash = 'settings';
          setTimeout(() => {
            document.querySelectorAll('.settings-sidebar button')[1]?.click();
            setTimeout(async () => {
              const raw = document.querySelector('textarea[data-config-draft="xray"]')?.value ?? '{}';
              const config = JSON.parse(raw);
              const rules = config.routing?.rules ?? [];
              const outbounds = config.outbounds ?? [];
              const apiTag = config.api?.tag ?? 'tachyon-xray-api';
              const apiInboundTags = new Set(
                (config.inbounds ?? [])
                  .map((inbound) => inbound?.tag)
                  .filter((tag) => typeof tag === 'string' && tag.includes('tachyon-xray-api-in')),
              );
              const isApiRule = (rule) =>
                rule?.outboundTag === apiTag
                || rule?.outboundTag === 'tachyon-xray-api'
                || (Array.isArray(rule?.inboundTag)
                  && rule.inboundTag.some((tag) => apiInboundTags.has(tag)));
              const trafficRules = rules.filter((rule) => !isApiRule(rule));
              const isExplicitCatchAll = (rule) =>
                Boolean(rule?.outboundTag)
                && Object.keys(rule).every(
                  (key) => key === 'type' || key === 'network' || key === 'outboundTag',
                );
              const catchAllRule = trafficRules.find(isExplicitCatchAll) ?? {};
              const outboundTagCounts = outbounds.reduce((counts, outbound) => {
                const tag = typeof outbound?.tag === 'string' ? outbound.tag : '';
                if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
                return counts;
              }, new Map());
              const duplicateOutboundTags = Array.from(outboundTagCounts.entries())
                .filter(([, count]) => count > 1)
                .map(([tag]) => tag)
                .sort();
              const catchAllOutboundMatches = outbounds.filter(
                (outbound) => outbound?.tag === catchAllRule.outboundTag,
              );
              const catchAllOutbound = catchAllOutboundMatches.length === 1
                ? catchAllOutboundMatches[0]
                : {};
              const controlProtocols = new Set(['freedom', 'blackhole', 'dns', 'loopback']);
              const controlTag = (tag) =>
                typeof tag === 'string'
                && (tag === apiTag
                  || tag === 'tachyon-xray-api'
                  || tag.startsWith('tachyon-direct')
                  || tag.startsWith('tachyon-block')
                  || tag.startsWith('tachyon-xray-api-in')
                  || tag.startsWith('tachyon-socks')
                  || tag.startsWith('tachyon-http'));
              const trafficOutbounds = outbounds.filter(
                (outbound) => typeof outbound?.tag === 'string'
                  && !controlTag(outbound.tag)
                  && !controlProtocols.has(outbound?.protocol),
              );
              const directRule = trafficRules.find(
                (rule) => rule?.outboundTag?.startsWith('tachyon-direct')
                  && (Array.isArray(rule.ip) && rule.ip.includes('geoip:private')
                    || Array.isArray(rule.domain) && rule.domain.includes('geosite:private')),
              );
              const blockRule = trafficRules.find(
                (rule) => rule?.outboundTag?.startsWith('tachyon-block')
                  && Array.isArray(rule.protocol)
                  && rule.protocol.includes('bittorrent'),
              );
              const trafficOutboundTags = outbounds
                .map((outbound) => outbound?.tag)
                .filter((tag) => trafficOutbounds.some((outbound) => outbound.tag === tag));
              const vault = JSON.parse(
                localStorage.getItem('tachyon.prism.uiSmokeVault.v1') || 'null',
              );
              const subscriptions = vault?.payload?.subscriptions;
              const selectedSubscriptionId = subscriptions?.selectedSubscriptionId ?? '';
              const selectedNodeId = subscriptions?.selectedNodeId ?? '';
              const activeSubscription = Array.isArray(subscriptions?.subscriptions)
                ? subscriptions.subscriptions.find(
                    (subscription) => subscription?.id === selectedSubscriptionId,
                  )
                : undefined;
              const selectedNode = Array.isArray(activeSubscription?.nodes)
                ? activeSubscription.nodes.find((node) => node?.id === selectedNodeId)
                : undefined;
              const selectedTemplate = selectedNode?.xrayConfigId
                ? activeSubscription?.xrayConfigTemplates?.[selectedNode.xrayConfigId]
                : undefined;
              const selectedTemplateOutbound = Number.isInteger(selectedNode?.xrayOutboundIndex)
                && Array.isArray(selectedTemplate?.outbounds)
                ? selectedTemplate.outbounds[selectedNode.xrayOutboundIndex]
                : undefined;
              const selectedNodeOutbound = selectedTemplateOutbound ?? selectedNode?.outbound;
              const selectedNodeOutboundTag = selectedNodeOutbound?.tag ?? '';
              const outboundEvidence = await globalThis.TachyonOutboundEvidence.compareOutbounds(
                selectedNodeOutbound,
                catchAllOutbound,
              );
              const catchAllIndex = trafficRules.findIndex(isExplicitCatchAll);
              resolve({
                domainStrategy: config.routing?.domainStrategy ?? '',
                firstTrafficOutboundTag: trafficRules[0]?.outboundTag ?? '',
                firstConfiguredTrafficOutboundTag: trafficOutboundTags[0] ?? '',
                selectedSubscriptionId,
                selectedNodeId,
                selectedNodeName: selectedNode?.name ?? '',
                selectedNodeOutboundTag,
                selectedOutboundDescriptor: outboundEvidence.selectedDescriptor,
                selectedOutboundHmac: outboundEvidence.selectedHmac,
                catchAllOutboundTag: catchAllRule.outboundTag ?? '',
                catchAllProtocol: catchAllOutbound.protocol ?? '',
                catchAllOutboundDescriptor: outboundEvidence.catchAllDescriptor,
                catchAllOutboundHmac: outboundEvidence.catchAllHmac,
                catchAllIsExplicit: Boolean(catchAllRule.outboundTag),
                catchAllTargetIsConfigured: catchAllOutboundMatches.length === 1,
                catchAllTargetIsTrafficOutbound: trafficOutboundTags.includes(catchAllRule.outboundTag),
                selectedNodeIsConfiguredTrafficOutbound: trafficOutboundTags.includes(selectedNodeOutboundTag),
                selectedNodeTagReferenceCount: outbounds.filter(
                  (outbound) => outbound?.tag === selectedNodeOutboundTag,
                ).length,
                duplicateOutboundTags,
                outboundObjectsMatch: outboundEvidence.objectsMatch,
                trafficRulesBeforeCatchAll: catchAllIndex < 0 ? -1 : catchAllIndex,
                catchAllRejectedProtocol: controlProtocols.has(catchAllOutbound.protocol ?? '')
                  || controlTag(catchAllOutbound.tag),
                hasApiRule: rules.some(isApiRule),
                hasBlockRule: Boolean(blockRule),
                hasPrivateDirectRule: Boolean(directRule),
                ruleCount: rules.length
              });
            }, 350);
          }, 350);
        })
        """,
        await_promise=True,
    )


def advanced_xray_payload() -> str:
    return json.dumps(
        {
            "dns": {"servers": ["1.1.1.1"]},
            "inbounds": [
                {"tag": "custom-in-a", "protocol": "socks", "settings": {}},
                {"tag": "custom-in-b", "protocol": "http", "settings": {}},
            ],
            "outbounds": [
                {"tag": "custom-out-a", "protocol": "freedom", "settings": {}},
                {"tag": "custom-out-b", "protocol": "blackhole", "settings": {}},
            ],
            "futureSmokeField": {"untouched": [1, 2, 3]},
        },
        separators=(",", ":"),
    )


def assert_advanced_xray_layout(cdp: CDP, language: str) -> None:
    expected = {
        "zh-CN": {
            "actions": {"导入 JSON", "导出 JSON", "恢复有效配置", "恢复生成配置"},
            "heading": "高级 Xray JSON",
            "toggle": "使用高级完整配置",
        },
        "en": {
            "actions": {"Import JSON", "Export JSON", "Restore Valid", "Restore Generated"},
            "heading": "Advanced Xray JSON",
            "toggle": "Use advanced complete config",
        },
    }[language]
    state = cdp.evaluate(
        """
        new Promise((resolve) => {
          location.hash = 'settings';
          setTimeout(() => {
            document.querySelectorAll('.settings-sidebar button')[1]?.click();
            setTimeout(() => {
              const toggle = document.querySelector('[data-xray-advanced-toggle]');
              if (!toggle) throw new Error('advanced Xray toggle missing');
              if (!toggle.checked) toggle.click();
              setTimeout(() => {
                const editor = document.querySelector('[data-xray-advanced-editor="enabled"]');
                const panel = editor?.closest('.settings-card');
                const content = document.querySelector('.prism-content');
                const actions = panel?.querySelector('.xray-editor-actions');
                if (!editor || !panel || !content || !actions) {
                  throw new Error('advanced Xray editor layout missing');
                }
                actions.scrollIntoView({ block: 'start' });
                setTimeout(() => {
                  const actionsRect = actions.getBoundingClientRect();
                  const contentRect = content.getBoundingClientRect();
                  const actionsReachable =
                    actionsRect.top >= contentRect.top - 2 &&
                    actionsRect.bottom <= contentRect.bottom + 2;
                  editor.scrollIntoView({ block: 'end' });
                  setTimeout(() => {
                    const editorRect = editor.getBoundingClientRect();
                    const finalContentRect = content.getBoundingClientRect();
                    const controls = Array.from(
                      actions.querySelectorAll('button, .file-action-button')
                    );
                    resolve({
                      actionLabels: controls.map((item) => item.textContent.trim()),
                      actionsReachable,
                      editorReachable:
                        editorRect.top >= finalContentRect.top - 2 &&
                        editorRect.bottom <= finalContentRect.bottom + 2,
                      editorLabel: editor.getAttribute('aria-label') ?? '',
                      labelsFit: controls.every((item) => item.scrollWidth <= item.clientWidth + 1),
                      noHorizontalOverflow:
                        document.documentElement.scrollWidth <= window.innerWidth &&
                        document.body.scrollWidth <= window.innerWidth &&
                        panel.scrollWidth <= panel.clientWidth,
                      toggleLabel: toggle.closest('label')?.textContent.trim() ?? '',
                    });
                  }, 220);
                }, 220);
              }, 300);
            }, 350);
          }, 350);
        })
        """,
        await_promise=True,
    )
    if set(state["actionLabels"]) != expected["actions"]:
        raise AssertionError(f"advanced Xray {language} action labels mismatch: {state}")
    if state["editorLabel"] != expected["heading"] or state["toggleLabel"] != expected["toggle"]:
        raise AssertionError(f"advanced Xray {language} entry labels mismatch: {state}")
    required = ["actionsReachable", "editorReachable", "labelsFit", "noHorizontalOverflow"]
    if not all(state.get(key) for key in required):
        raise AssertionError(f"advanced Xray {language} fixed-window layout failed: {state}")
    assert_no_horizontal_overflow(cdp)


def assert_subscription_refresh_preserves_advanced_xray(cdp: CDP) -> None:
    payload = advanced_xray_payload()
    preserved = cdp.evaluate(
        f"""
        new Promise((resolve) => {{
          location.hash = 'settings';
          setTimeout(() => {{
            document.querySelectorAll('.settings-sidebar button')[1]?.click();
            setTimeout(() => {{
              const toggle = document.querySelector('[data-xray-advanced-toggle]');
              if (!toggle.checked) toggle.click();
              setTimeout(() => {{
                const editor = document.querySelector('[data-xray-advanced-editor="enabled"]');
                const descriptor = Object.getOwnPropertyDescriptor(
                  Object.getPrototypeOf(editor),
                  'value'
                );
                descriptor.set.call(editor, {json.dumps(payload)});
                editor.dispatchEvent(new Event('input', {{ bubbles: true }}));
                setTimeout(() => {{
                  location.hash = 'subscriptions';
                  setTimeout(() => {{
                    const refresh = Array.from(document.querySelectorAll('button')).find(
                      (button) => button.textContent.trim() === 'Update All'
                    );
                    if (!refresh) throw new Error('Update All button missing');
                    refresh.click();
                    setTimeout(() => {{
                      location.hash = 'settings';
                      setTimeout(() => {{
                        document.querySelectorAll('.settings-sidebar button')[1]?.click();
                        setTimeout(() => {{
                          const current = document.querySelector(
                            '[data-xray-advanced-editor="enabled"]'
                          );
                          resolve(current?.value === {json.dumps(payload)});
                        }}, 350);
                      }}, 350);
                    }}, 800);
                  }}, 350);
                }}, 250);
              }}, 250);
            }}, 350);
          }}, 350);
        }})
        """,
        await_promise=True,
    )
    if not preserved:
        raise AssertionError("subscription refresh replaced the advanced Xray JSON source")


def exercise_advanced_xray_editor(cdp: CDP) -> dict[str, Any]:
    payload = advanced_xray_payload()
    return cdp.evaluate(
        f"""
        new Promise((resolve) => {{
          location.hash = 'settings';
          setTimeout(() => {{
            document.querySelectorAll('.settings-sidebar button')[1]?.click();
            setTimeout(() => {{
              const toggle = document.querySelector('[data-xray-advanced-toggle]');
              if (!toggle) throw new Error('advanced Xray toggle missing');
              if (!toggle.checked) toggle.click();
              setTimeout(() => {{
                const editor = document.querySelector('[data-xray-advanced-editor="enabled"]');
                if (!editor || editor.readOnly) throw new Error('advanced Xray editor is not editable');
                const descriptor = Object.getOwnPropertyDescriptor(
                  Object.getPrototypeOf(editor),
                  'value'
                );
                const setEditor = (value) => {{
                  descriptor.set.call(editor, value);
                  editor.dispatchEvent(new Event('input', {{ bubbles: true }}));
                }};
                const restoreBeforeSave = Array.from(
                  editor.closest('.settings-card').querySelectorAll('.xray-editor-actions button')
                ).find((button) => button.textContent.includes('Restore Valid'));
                const restoreInitiallyDisabled = Boolean(restoreBeforeSave?.disabled);
                setEditor({json.dumps(payload)});
                setTimeout(() => {{
                  const panel = editor.closest('.settings-card');
                  const save = Array.from(panel.querySelectorAll('header button')).find((button) =>
                    button.textContent.trim() === 'Save'
                  );
                  if (!save) throw new Error('config save button missing');
                  save.click();
                  setTimeout(() => {{
                    const restore = Array.from(panel.querySelectorAll('.xray-editor-actions button')).find(
                      (button) => button.textContent.includes('Restore Valid')
                    );
                    const generated = Array.from(panel.querySelectorAll('.xray-editor-actions button')).find(
                      (button) => button.textContent.includes('Restore Generated')
                    );
                    const importInput = panel.querySelector('[data-xray-json-import]');
                    const exportButton = Array.from(panel.querySelectorAll('.xray-editor-actions button')).find(
                      (button) => button.textContent.includes('Export JSON')
                    );
                    const validSaved = !restore?.disabled && editor.value === {json.dumps(payload)};
                    setEditor('{{');
                    setTimeout(() => {{
                      save.click();
                      setTimeout(() => {{
                        const syntaxVisible = document.body.innerText.includes('Xray JSON syntax error');
                        restore.click();
                        setTimeout(() => {{
                          const restoredExact = editor.value === {json.dumps(payload)};
                          generated.click();
                          setTimeout(() => {{
                            let generatedConfig = {{}};
                            try {{ generatedConfig = JSON.parse(editor.value); }} catch {{}}
                            const actionLabels = Array.from(
                              panel.querySelectorAll('.xray-editor-actions button, .file-action-button')
                            ).map((item) => item.textContent.trim());
                            const noHorizontalOverflow =
                              document.documentElement.scrollWidth <= window.innerWidth &&
                              document.body.scrollWidth <= window.innerWidth &&
                              panel.scrollWidth <= panel.clientWidth;
                            resolve({{
                              actionLabels,
                              exportPresent: Boolean(exportButton),
                              generatedRestored: Boolean(generatedConfig.routing),
                              importPresent: Boolean(importInput),
                              noHorizontalOverflow,
                              restoreInitiallyDisabled,
                              restoredExact,
                              syntaxVisible,
                              toggleLabel: toggle.closest('label')?.textContent.trim() ?? '',
                              validSaved,
                            }});
                          }}, 300);
                        }}, 300);
                      }}, 350);
                    }}, 250);
                  }}, 450);
                }}, 250);
              }}, 300);
            }}, 350);
          }}, 350);
        }})
        """,
        await_promise=True,
    )


def configure_tachyon_server(cdp: CDP, server: str) -> str:
    host, _, port = server.partition(":")
    port = port or "443"
    return str(
        cdp.evaluate(
            f"""
            new Promise((resolve) => {{
              location.hash = 'settings';
              setTimeout(() => {{
                document.querySelectorAll('.settings-sidebar button')[1]?.click();
                setTimeout(() => {{
                  const setValue = (selector, value) => {{
                    const input = document.querySelector(selector);
                    if (!input) throw new Error(`missing Tachyon server profile field: ${{selector}}`);
                    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
                    descriptor.set.call(input, value);
                    input.dispatchEvent(new Event('input', {{ bubbles: true }}));
                  }};
                  setValue('input[placeholder="Game Relay"]', 'Smoke Game Relay');
                  setValue('input[placeholder="game.example.com"]', {json.dumps(host)});
                  setValue('input[type="number"][max="65535"]', {json.dumps(port)});
                  setValue('input[placeholder="server.json: tgp.auth.psk"]', 'smoke-psk-012345');
                  const save = Array.from(document.querySelectorAll('.tachyon-server-panel header button'))
                    .find((button) => button.textContent.includes('Save') || button.textContent.includes('淇濆瓨'));
                  if (!save) throw new Error('Tachyon server profile save button missing');
                  save.click();
                  setTimeout(() => resolve(document.body.innerText), 350);
                }}, 350);
              }}, 350);
            }})
            """,
            await_promise=True,
        ),
    )


def assert_local_proxy_probe_panel(cdp: CDP) -> None:
    state = cdp.evaluate(
        """
        new Promise((resolve) => {
          location.hash = 'overview';
          setTimeout(() => {
            const panel = document.querySelector('.proxy-probe-panel');
            const button = panel?.querySelector('button');
            resolve({
              text: panel?.textContent ?? '',
              disabled: Boolean(button?.disabled),
              rows: Array.from(panel?.querySelectorAll('.proxy-probe-row') ?? [])
                .map((row) => row.textContent)
            });
          }, 350);
        })
        """,
        await_promise=True,
    )
    if "Local Proxy Probe" not in state["text"] or "Verify Selected Node" not in state["text"]:
        raise AssertionError(f"local proxy probe panel missing: {state}")
    if state["disabled"]:
        raise AssertionError(
            f"isolated node verification should be available while Xray is stopped: {state}"
        )
    rows = state["rows"]
    if len(rows) != 2 or not any("HTTP" in row for row in rows) or not any("SOCKS" in row for row in rows):
        raise AssertionError(f"local proxy probe rows missing: {state}")


def assert_key_pages_at_viewports(cdp: CDP, output_dir: Path) -> None:
    viewports = [(1024, 720), (1366, 768)]
    pages = ["overview", "subscriptions", "plugins", "settings"]
    for width, height in viewports:
        set_viewport(cdp, width, height)
        for page in pages:
            text = navigate_hash(cdp, page)
            if page == "settings":
                text = select_settings_section(cdp, 1)
            assert_no_runtime_error(text)
            assert_no_horizontal_overflow(cdp)
            assert_no_shell_overflow(cdp, page)
            if page == "overview":
                assert_content_fits_viewport(cdp)
            assert_viewport(cdp, width, height)
            cdp.screenshot(output_dir / f"{page}-{width}x{height}.png")


def capture_fixed_window_pages(cdp: CDP, output_dir: Path, language: str) -> None:
    expected = {
        "zh-CN": {
            "overview": "工作模式",
            "subscriptions": "更新全部",
            "plugins": "插件中心",
            "settings": "通用设置",
        },
        "en": {
            "overview": "Work Mode",
            "subscriptions": "Update All",
            "plugins": "Plugin Center",
            "settings": "General Settings",
        },
    }[language]
    set_viewport(cdp, 800, 540)
    for page, page_marker in expected.items():
        text = navigate_hash(cdp, page)
        if page == "settings":
            text = select_settings_section(cdp, 0)
        assert_contains(text, page_marker)
        assert_no_runtime_error(text)
        assert_no_horizontal_overflow(cdp)
        assert_no_shell_overflow(cdp, page)
        if page == "overview":
            assert_content_fits_viewport(cdp)
        assert_content_scroll_is_contained(cdp)
        assert_fixed_window_labels_fit(cdp, page)
        assert_desktop_viewport(cdp)
        cdp.screenshot(output_dir / f"{page}-800x540-{language}.png")


def core_config_summary(cdp: CDP) -> dict[str, Any]:
    return cdp.evaluate(
        """
        new Promise((resolve) => {
          location.hash = 'settings';
          setTimeout(() => {
            document.querySelectorAll('.settings-sidebar button')[1]?.click();
            setTimeout(() => {
              const raw = document.querySelector('textarea[data-config-draft="core"]')?.value ?? '{}';
              const config = JSON.parse(raw);
              resolve({
                serverAddr: config.client?.proxy?.server_addr ?? '',
                tgpServerAddr: config.client?.proxy?.tgp_server_addr ?? '',
                psk: config.tgp?.auth?.psk ?? '',
                tunAutoRoute: config.client?.tun?.auto_route ?? true,
                tunDnsHijack: config.client?.tun?.dns_hijack ?? true
              });
            }, 350);
          }, 350);
        })
        """,
        await_promise=True,
    )


def smoke_key_pages_at_viewport(cdp: CDP, width: int, height: int, output_dir: Path) -> None:
    set_viewport(cdp, width, height)
    for view in ["overview", "subscriptions", "settings"]:
        text = navigate_hash(cdp, view)
        assert_no_runtime_error(text)
        assert_no_horizontal_overflow(cdp)
        assert_no_shell_overflow(cdp, view)
        if view == "overview":
            assert_content_fits_viewport(cdp)
        assert_viewport(cdp, width, height)
        cdp.screenshot(output_dir / f"{view}-{width}x{height}.png")


def select_settings_section(cdp: CDP, index: int) -> str:
    return str(
        cdp.evaluate(
            f"""
            new Promise((resolve) => {{
              const button = document.querySelectorAll('.settings-sidebar button')[{index}];
              if (!button) throw new Error('settings section button missing: {index}');
              button.click();
              setTimeout(() => resolve(document.body.innerText), 350);
            }})
            """,
            await_promise=True,
        ),
    )


def click_validate_configs(cdp: CDP) -> str:
    return str(
        cdp.evaluate(
            """
            new Promise((resolve) => {
              const button = Array.from(document.querySelectorAll('button')).find((item) =>
                item.textContent.trim() === 'Validate Configs'
              );
              if (!button) throw new Error('Validate Configs button missing');
              button.click();
              setTimeout(() => resolve(document.body.innerText), 500);
            })
            """,
            await_promise=True,
        ),
    )


def switch_to_english(cdp: CDP) -> str:
    return str(
        cdp.evaluate(
            """
            new Promise((resolve) => {
              const button = Array.from(document.querySelectorAll('button')).find((item) =>
                item.textContent.trim() === 'English'
              );
              button.click();
              setTimeout(() => resolve(document.body.innerText), 450);
            })
            """,
            await_promise=True,
        ),
    )


def open_and_close_controller(cdp: CDP) -> str:
    return str(
        cdp.evaluate(
            """
            new Promise((resolve) => {
              const controller = Array.from(document.querySelectorAll('button')).find((item) =>
                item.textContent.trim() === '控制器' || item.textContent.trim() === 'Controller'
              );
              controller.click();
              setTimeout(() => {
                const text = document.body.innerText;
                const close = document.querySelector('.controller-close');
                close?.click();
                setTimeout(() => resolve(text), 300);
              }, 450);
            })
            """,
            await_promise=True,
        ),
    )


def open_and_close_node_picker(cdp: CDP) -> str:
    return str(
        cdp.evaluate(
            """
            new Promise((resolve) => {
              location.hash = 'overview';
              setTimeout(() => {
                const picker = document.querySelector('.current-node-card');
                if (!picker) throw new Error('overview current node picker missing');
                picker.click();
                setTimeout(() => {
                  const text = document.body.innerText;
                  if (!document.querySelector('.node-drawer')) {
                    throw new Error('node drawer did not open from overview');
                  }
                  document.querySelector('.node-drawer header button')?.click();
                  setTimeout(() => resolve(text), 300);
                }, 400);
              }, 350);
            })
            """,
            await_promise=True,
        ),
    )


def install_and_run_plugin(cdp: CDP, plugin_title: str) -> str:
    script = """
    new Promise((resolve) => {
      location.hash = 'plugins';
      setTimeout(() => {
        const card = Array.from(document.querySelectorAll('.plugin-rich-card')).find((item) =>
          item.textContent.includes(PLUGIN_TITLE_JSON)
        );
        if (!card) throw new Error('plugin card missing: ' + PLUGIN_TITLE_JSON);
        const install = Array.from(card.querySelectorAll('button')).find((item) =>
          item.textContent.trim() === '安装' || item.textContent.trim() === 'Install'
        );
        if (!install) throw new Error('plugin install button missing');
        install.click();
        setTimeout(() => {
          const run = Array.from(card.querySelectorAll('button')).find((item) =>
            item.textContent.includes('运行') || item.textContent.includes('Run')
          );
          if (!run || run.disabled) throw new Error('plugin run button unavailable');
          run.click();
          setTimeout(() => resolve(document.body.innerText), 450);
        }, 350);
      }, 350);
    })
    """.replace("PLUGIN_TITLE_JSON", json.dumps(plugin_title))
    return str(
        cdp.evaluate(
            script,
            await_promise=True,
        ),
    )


def assert_only_selected_plugin_installed(cdp: CDP, expected_plugin_id: str) -> None:
    state = cdp.evaluate(
        """
        (() => {
          const snapshot = JSON.parse(localStorage.getItem('tachyon.prism.plugins.v1') || '{}');
          return {
            installed: Object.entries(snapshot)
              .filter(([, value]) => Boolean(value?.installed))
              .map(([id]) => id),
            enabled: Object.entries(snapshot)
              .filter(([, value]) => Boolean(value?.installed && value?.enabled))
              .map(([id]) => id)
          };
        })()
        """,
    )
    if state["installed"] != [expected_plugin_id] or state["enabled"] != [expected_plugin_id]:
        raise AssertionError(f"plugin catalog installed more than the selected plugin: {state}")


def assert_focus_visible(cdp: CDP) -> None:
    state = cdp.evaluate(
        """
        (() => {
          const button = document.querySelector('.top-nav-item');
          if (!button) throw new Error('focus target missing');
          button.focus();
          const style = getComputedStyle(button);
          return {
            focused: document.activeElement === button,
            focusVisible: button.matches(':focus-visible'),
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth
          };
        })()
        """,
    )
    if not state["focused"] or not state["focusVisible"]:
        raise AssertionError(f"keyboard focus is not visible: {state}")
    if state["outlineStyle"] == "none" or state["outlineWidth"] in {"0px", ""}:
        raise AssertionError(f"focus-visible outline is missing: {state}")


def assert_appearance_persistence(cdp: CDP) -> str:
    state = cdp.evaluate(
        """
        new Promise((resolve) => {
          const clickSecond = (selector) => {
            const button = document.querySelector(`${selector} button:nth-child(2)`);
            if (!button) throw new Error('appearance button missing: ' + selector);
            button.click();
          };
          clickSecond('[data-testid="theme-setting"]');
          clickSecond('[data-testid="density-setting"]');
          clickSecond('[data-testid="motion-setting"]');
          setTimeout(() => resolve({
            theme: document.documentElement.dataset.theme,
            density: document.documentElement.dataset.density,
            motion: document.documentElement.dataset.motion
          }), 250);
        })
        """,
        await_promise=True,
    )
    if state != {"theme": "contrast", "density": "compact", "motion": "off"}:
        raise AssertionError(f"appearance controls did not apply: {state}")

    cdp.call("Page.reload", {"ignoreCache": True})
    text = wait_for_shell(cdp)
    persisted = cdp.evaluate(
        """
        (() => ({
          theme: document.documentElement.dataset.theme,
          density: document.documentElement.dataset.density,
          motion: document.documentElement.dataset.motion,
          stored: JSON.parse(localStorage.getItem('tachyon.prism.appearance.v1') || '{}'),
          activeTheme: document.querySelector('[data-testid="theme-setting"] button.active')?.textContent?.trim() ?? '',
          activeDensity: document.querySelector('[data-testid="density-setting"] button.active')?.textContent?.trim() ?? '',
          activeMotion: document.querySelector('[data-testid="motion-setting"] button.active')?.textContent?.trim() ?? ''
        }))()
        """,
    )
    expected = {"density": "compact", "motion": False, "theme": "contrast"}
    if persisted["stored"] != expected:
        raise AssertionError(f"appearance preferences were not persisted: {persisted}")
    if (persisted["theme"], persisted["density"], persisted["motion"]) != ("contrast", "compact", "off"):
        raise AssertionError(f"appearance dataset was not restored: {persisted}")
    if (persisted["activeTheme"], persisted["activeDensity"], persisted["activeMotion"]) != (
        "High Contrast",
        "Compact",
        "Off",
    ):
        raise AssertionError(f"appearance controls did not restore their active state: {persisted}")
    return str(
        cdp.evaluate(
            """
            new Promise((resolve) => {
              document.querySelector('[data-testid="theme-setting"] button:first-child')?.click();
              document.querySelector('[data-testid="density-setting"] button:first-child')?.click();
              document.querySelector('[data-testid="motion-setting"] button:first-child')?.click();
              setTimeout(() => resolve(document.body.innerText), 250);
            })
            """,
            await_promise=True,
        ),
    )


def assert_ui_smoke_vault_migration_and_reload(cdp: CDP) -> None:
    prepared = cdp.evaluate(
        """
        (() => {
          const vaultKey = 'tachyon.prism.uiSmokeVault.v1';
          const legacyKey = 'tachyon.prism.subscription.v1';
          const vault = JSON.parse(localStorage.getItem(vaultKey) || 'null');
          const subscriptions = vault?.payload?.subscriptions;
          if (!subscriptions) return { prepared: false, reason: 'subscription section missing' };
          const profiles = Array.isArray(subscriptions.subscriptions) ? subscriptions.subscriptions : [];
          const active = profiles.find((profile) => profile.id === subscriptions.selectedSubscriptionId);
          const selected = active?.nodes?.find((node) => node.id === subscriptions.selectedNodeId);
          const nodeNames = profiles
            .flatMap((profile) => profile.nodes ?? [])
            .map((node) => node.name)
            .sort();
          localStorage.removeItem(vaultKey);
          localStorage.setItem(legacyKey, JSON.stringify(subscriptions));
          return {
            prepared: true,
            nodeNames,
            selectedNodeName: selected?.name ?? '',
            selectedSubscriptionName: active?.name ?? ''
          };
        })()
        """,
    )
    if prepared != {
        "prepared": True,
        "nodeNames": [
            "Clash Smoke SS",
            "Clash Smoke VLESS",
            "Smoke Hysteria",
            "Smoke Trojan",
            "Smoke URL Trojan",
            "Smoke URL VLESS",
            "Smoke VLESS",
        ],
        "selectedNodeName": "Clash Smoke SS",
        "selectedSubscriptionName": "Clash Smoke",
    }:
        raise AssertionError(f"UI smoke vault migration fixture was not prepared: {prepared}")
    cdp.call("Page.reload", {"ignoreCache": True})
    wait_for_shell(cdp)
    text = navigate_hash(cdp, "subscriptions")
    assert_contains(text, "Smoke URL", "Clash Smoke", "Clash Smoke SS")
    initial_selection = cdp.evaluate(
        """
        (() => ({
          activeCard: document.querySelector('.subscription-card.active strong')?.textContent?.trim() ?? '',
          activeNode: document.querySelector('.node-tile.active strong')?.textContent?.trim() ?? ''
        }))()
        """
    )
    if initial_selection != {"activeCard": "Clash Smoke", "activeNode": "Clash Smoke SS"}:
        raise AssertionError(f"UI smoke migration did not restore the selected node: {initial_selection}")
    text = choose_subscription(cdp, "Smoke URL")
    assert_contains(text, "Smoke URL VLESS", "Smoke URL Trojan")
    text = choose_subscription(cdp, "Clash Smoke")
    assert_contains(text, "Clash Smoke SS", "Clash Smoke VLESS")
    text = choose_node(cdp, "Clash Smoke SS")
    assert_contains(text, "Clash Smoke SS")
    cdp.call("Page.reload", {"ignoreCache": True})
    wait_for_shell(cdp)
    navigate_hash(cdp, "subscriptions")
    migrated = cdp.evaluate(
        """
        (() => {
          const raw = localStorage.getItem('tachyon.prism.uiSmokeVault.v1');
          const subscriptions = raw ? JSON.parse(raw)?.payload?.subscriptions : null;
          const profiles = Array.isArray(subscriptions?.subscriptions) ? subscriptions.subscriptions : [];
          const active = profiles.find((profile) => profile.id === subscriptions?.selectedSubscriptionId);
          const selected = active?.nodes?.find((node) => node.id === subscriptions?.selectedNodeId);
          const nodeNames = profiles.flatMap((profile) => profile.nodes ?? []).map((node) => node.name);
          const activeCard = document.querySelector('.subscription-card.active strong')?.textContent?.trim() ?? '';
          const activeNode = document.querySelector('.node-tile.active strong')?.textContent?.trim() ?? '';
          return {
            legacyRemoved: localStorage.getItem('tachyon.prism.subscription.v1') === null,
            vaultPresent: Boolean(raw),
            marker: localStorage.getItem('tachyon.prism.secureMigration.v1'),
            urlNodePreserved: nodeNames.includes('Smoke URL VLESS'),
            clashNodePreserved: nodeNames.includes('Clash Smoke SS'),
            selectedSubscriptionName: active?.name ?? '',
            selectedNodeName: selected?.name ?? '',
            activeCard,
            activeNode
          };
        })()
        """,
    )
    if migrated != {
        "legacyRemoved": True,
        "vaultPresent": True,
        "marker": "complete",
        "urlNodePreserved": True,
        "clashNodePreserved": True,
        "selectedSubscriptionName": "Clash Smoke",
        "selectedNodeName": "Clash Smoke SS",
        "activeCard": "Clash Smoke",
        "activeNode": "Clash Smoke SS",
    }:
        raise AssertionError(f"UI smoke vault migration did not verify and delete legacy data: {migrated}")


def capture_failure_screenshot(cdp: CDP | None, output_dir: Path) -> str | None:
    if cdp is None:
        return None
    path = output_dir / "failure-startup.png"
    try:
        data = cdp.call(
            "Page.captureScreenshot",
            {"captureBeyondViewport": False, "format": "png", "fromSurface": True},
            timeout=5.0,
        )["data"]
        path.write_bytes(base64.b64decode(data))
        return path.name
    except Exception:  # noqa: BLE001 - the remaining diagnostics must still be written.
        return None


def collect_failure_diagnostics(
    *,
    output_dir: Path,
    phase: str,
    error: Exception,
    edge: subprocess.Popen[Any] | None,
    endpoint: dict[str, Any] | None,
    user_dir: Path,
    stdout_path: Path,
    stderr_path: Path,
    cdp: CDP | None,
) -> Path:
    screenshot = capture_failure_screenshot(cdp, output_dir)
    endpoint_port = int(endpoint["port"]) if endpoint is not None else None
    ready_file = user_dir / "DevToolsActivePort"
    ready_port: int | None = None
    ready_status = "absent"
    if ready_file.exists():
        try:
            ready_port, _ = parse_devtools_active_port(ready_file)
            ready_status = "valid"
        except Exception:
            ready_status = "invalid"
    version_snapshot: dict[str, Any] | None = None
    probe_port = endpoint_port or ready_port
    if probe_port is not None:
        try:
            version = read_json(f"http://127.0.0.1:{probe_port}/json/version", timeout=1.0)
            version_snapshot = {
                "browser": str(version.get("Browser", "unknown"))[:120],
                "protocolVersion": str(version.get("Protocol-Version", "unknown"))[:40],
                "port": probe_port,
            }
        except Exception as probe_error:  # noqa: BLE001 - best-effort diagnostics.
            version_snapshot = {"port": probe_port, "probeError": type(probe_error).__name__}
    parsed_page = urlparse(str(endpoint.get("pageUrl", ""))) if endpoint else None
    diagnostics = {
        "status": "failed",
        "phase": phase,
        "errorType": type(error).__name__,
        "error": sanitize_diagnostic_text(str(error)),
        "process": {
            "pid": edge.pid if edge is not None else None,
            "exitCode": edge.poll() if edge is not None else None,
            "alive": edge is not None and edge.poll() is None,
        },
        "cdp": {
            "port": endpoint_port,
            "ownership": endpoint.get("ownership") if endpoint else None,
            "browser": endpoint.get("browser") if endpoint else None,
            "pageOrigin": (
                f"{parsed_page.scheme}://{parsed_page.hostname}:{parsed_page.port}"
                if parsed_page and parsed_page.hostname
                else None
            ),
            "endpointAcceptingConnections": port_accepting_connections(probe_port),
            "version": version_snapshot,
        },
        "readyFile": {"status": ready_status, "port": ready_port},
        "logs": {
            "stdoutTail": read_log_tail(stdout_path),
            "stderrTail": read_log_tail(stderr_path),
        },
        "failureScreenshot": screenshot,
    }
    path = output_dir / "DIAGNOSTICS.json"
    write_json(path, diagnostics)
    return path


def run(
    edge_path: Path,
    port: int,
    output_dir: Path,
    *,
    startup_only: bool = False,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    server = start_server(port)
    port = int(server.server_address[1])
    # Crashpad can briefly keep files locked on Windows after Edge exits.
    user_dir = tempfile.TemporaryDirectory(
        prefix="tachyon-prism-edge-",
        ignore_cleanup_errors=True,
    )
    user_dir_path = Path(user_dir.name)
    stdout_path = user_dir_path / "edge.stdout.log"
    stderr_path = user_dir_path / "edge.stderr.log"
    cdp: CDP | None = None
    edge: subprocess.Popen[Any] | None = None
    endpoint: dict[str, Any] | None = None
    stdout_file = None
    stderr_file = None
    phase = "Edge launch"
    cleanup_port: int | None = None
    failed = False
    try:
        stdout_file = stdout_path.open("w", encoding="utf-8", errors="replace")
        stderr_file = stderr_path.open("w", encoding="utf-8", errors="replace")
        popen_options: dict[str, Any] = {}
        if os.name == "nt":
            popen_options["creationflags"] = (
                getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                | getattr(subprocess, "CREATE_NO_WINDOW", 0)
            )
        else:
            popen_options["start_new_session"] = True
        page_url = f"http://127.0.0.1:{port}/"
        edge = subprocess.Popen(
            [
                str(edge_path),
                "--headless",
                "--disable-background-networking",
                "--disable-breakpad",
                "--disable-crash-reporter",
                "--edge-skip-compat-layer-relaunch",
                "--disable-extensions",
                "--disable-gpu",
                "--disable-gpu-sandbox",
                "--no-default-browser-check",
                "--no-first-run",
                "--no-sandbox",
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=0",
                "--remote-allow-origins=*",
                f"--user-data-dir={user_dir.name}",
                "--window-size=800,540",
                page_url,
            ],
            stdin=subprocess.DEVNULL,
            stderr=stderr_file,
            stdout=stdout_file,
            **popen_options,
        )
        phase = "CDP endpoint discovery"
        endpoint = wait_edge_endpoint(edge, user_dir_path, page_url)
        cleanup_port = int(endpoint["port"])
        phase = "CDP WebSocket handshake"
        cdp = connect_cdp(edge, endpoint)
        cdp.call("Runtime.enable")
        cdp.call("Page.enable")
        set_viewport(cdp, 800, 540)

        phase = "Prism shell readiness"
        text = wait_for_shell(cdp)
        assert_contains(text, "Tachyon Prism", "系统代理", "实时流量")
        assert_no_runtime_error(text)
        assert_no_horizontal_overflow(cdp)
        assert_no_shell_overflow(cdp, "overview")
        assert_content_fits_viewport(cdp)
        assert_desktop_viewport(cdp)
        assert_custom_window_chrome(cdp)
        assert_desktop_interaction_polish(cdp)
        assert_focus_visible(cdp)
        assert_dual_core_chart(cdp)
        cdp.screenshot(output_dir / "overview-desktop.png")
        if startup_only:
            return {
                "status": "passed",
                "scope": "startup-cdp-stress",
                "artifactDirectory": str(output_dir.resolve()),
                "edgeExecutable": str(edge_path.resolve()),
                "port": port,
                "cdp": {
                    "ownership": endpoint["ownership"],
                    "browser": endpoint["browser"],
                },
                "viewport": {"width": 800, "height": 540},
            }
        phase = "full UI evidence"
        text = open_and_close_controller(cdp)
        assert_contains(text, "策略组", "节点选择", "自动选择")
        assert_no_runtime_error(text)

        text = navigate_hash(cdp, "subscriptions")
        assert_contains(text, "订阅", "节点选择")
        assert_no_runtime_error(text)
        add_state = click_add_subscription(cdp)
        if add_state["activeTag"] != "INPUT":
            raise AssertionError(f"add subscription did not focus the form: {add_state}")
        text = assert_subscription_interaction_contract(cdp, port)
        assert_contains(text, "Smoke URL", "Smoke URL VLESS", "Smoke URL Trojan")
        text = import_sample_subscription(cdp)
        assert_contains(text, "Smoke", "Smoke VLESS", "Smoke Trojan", "Smoke Hysteria")
        text = import_clash_subscription(cdp)
        assert_contains(text, "Clash Smoke", "Clash Smoke VLESS", "Clash Smoke SS")
        text = choose_node(cdp, "Clash Smoke SS")
        assert_contains(text, "Clash Smoke SS")
        assert_contains_any(text, "Node selected", "节点已选择")
        assert_selected_subscription_persisted(cdp, "Clash Smoke", "Clash Smoke SS")
        text = open_and_close_node_picker(cdp)
        assert_contains(text, "节点选择", "Clash Smoke SS")
        assert_desktop_viewport(cdp)
        text = navigate_hash(cdp, "subscriptions")
        assert_contains(text, "更新全部", "Clash Smoke SS")
        cdp.screenshot(output_dir / "subscriptions-desktop.png")

        text = navigate_hash(cdp, "configs")
        assert_contains(text, "策略组", "节点选择", "自动选择", "漏网之鱼", "Clash Smoke SS")
        assert_no_runtime_error(text)
        assert_no_horizontal_overflow(cdp)
        assert_desktop_viewport(cdp)
        cdp.screenshot(output_dir / "configs-desktop.png")

        text = switch_routing_mode(cdp, "global")
        assert_contains_any(text, "mode selected", "模式已选择")
        if active_routing_mode(cdp) != "global":
            raise AssertionError("global routing mode did not become active")
        global_summary = xray_routing_summary(cdp)
        if (
            not global_summary["hasApiRule"]
            or not global_summary["catchAllIsExplicit"]
            or not global_summary["catchAllTargetIsConfigured"]
            or not global_summary["catchAllTargetIsTrafficOutbound"]
            or not global_summary["selectedSubscriptionId"]
            or not global_summary["selectedNodeId"]
            or not global_summary["selectedNodeName"]
            or not global_summary["selectedNodeOutboundTag"]
            or not global_summary["selectedNodeIsConfiguredTrafficOutbound"]
            or global_summary["selectedNodeTagReferenceCount"] != 1
            or global_summary["duplicateOutboundTags"]
            or not global_summary["outboundObjectsMatch"]
            or not global_summary["selectedOutboundDescriptor"]["protocol"]
            or not global_summary["selectedOutboundDescriptor"]["address"]
            or global_summary["selectedOutboundDescriptor"]["port"] <= 0
            or len(global_summary["selectedOutboundHmac"]) != 64
            or len(global_summary["catchAllOutboundHmac"]) != 64
            or global_summary["trafficRulesBeforeCatchAll"] != 0
            or global_summary["catchAllRejectedProtocol"]
            or global_summary["firstTrafficOutboundTag"] != global_summary["catchAllOutboundTag"]
            or global_summary["selectedNodeOutboundTag"] != global_summary["catchAllOutboundTag"]
            or global_summary["catchAllProtocol"] in ("", "freedom", "blackhole")
        ):
            raise AssertionError(f"global routing config mismatch: {global_summary}")

        text = switch_routing_mode(cdp, "direct")
        assert_contains_any(text, "mode selected", "模式已选择")
        if active_routing_mode(cdp) != "direct":
            raise AssertionError("direct routing mode did not become active")
        summary = xray_routing_summary(cdp)
        if (
            not summary["hasApiRule"]
            or not summary["catchAllIsExplicit"]
            or not summary["catchAllTargetIsConfigured"]
            or summary["firstTrafficOutboundTag"] != summary["catchAllOutboundTag"]
            or summary["catchAllProtocol"] != "freedom"
        ):
            raise AssertionError(f"direct routing config mismatch: {summary}")

        text = switch_routing_mode(cdp, "rule")
        assert_contains_any(text, "mode selected", "模式已选择")
        if active_routing_mode(cdp) != "rule":
            raise AssertionError("rule routing mode did not become active")
        summary = xray_routing_summary(cdp)
        if (
            summary["domainStrategy"] != "IPIfNonMatch"
            or not summary["hasApiRule"]
            or not summary["hasBlockRule"]
            or not summary["hasPrivateDirectRule"]
            or not summary["catchAllIsExplicit"]
            or not summary["catchAllTargetIsConfigured"]
            or not summary["catchAllTargetIsTrafficOutbound"]
            or summary["catchAllRejectedProtocol"]
        ):
            raise AssertionError(f"rule routing config mismatch: {summary}")
        cdp.screenshot(output_dir / "routing-modes-desktop.png")

        text = navigate_hash(cdp, "plugins")
        catalog = cdp.evaluate(
            """
            new Promise((resolve) => {
              document.querySelector('[data-testid="open-plugin-catalog"]')?.click();
              setTimeout(() => resolve({
                open: Boolean(document.querySelector('[data-testid="plugin-catalog"]')),
                installButtons: Array.from(document.querySelectorAll('[data-testid="plugin-catalog"] button'))
                  .filter((button) => !button.disabled).length
              }), 200);
            })
            """,
            await_promise=True,
        )
        if not catalog["open"] or catalog["installButtons"] < 2:
            raise AssertionError(f"plugin catalog did not open as a selective installer: {catalog}")
        cdp.evaluate("document.querySelector('[data-testid=\"open-plugin-catalog\"]')?.click()")
        assert_contains(text, "插件中心", "滚动发行", "节点转换")
        assert_no_runtime_error(text)
        text = install_and_run_plugin(cdp, "节点智能切换")
        assert_contains(text, "已启用", "运行次数: 1", "->")
        assert_only_selected_plugin_installed(cdp, "smart-node-switch")
        assert_desktop_viewport(cdp)
        cdp.screenshot(output_dir / "plugins-desktop.png")
        capture_fixed_window_pages(cdp, output_dir, "zh-CN")

        text = navigate_hash(cdp, "settings")
        text = select_settings_section(cdp, 0)
        assert_contains(text, "通用设置", "语言")
        assert_no_runtime_error(text)
        text = select_settings_section(cdp, 1)
        assert_contains(text, "诊断", "稳定", "预览", "诊断仅使用已保存的运行时设置")
        assert_not_contains(
            text,
            "Channel",
            "Configured path missing",
            "Diagnose uses saved runtime settings",
            "Installed version",
            "Not installed",
            "Preview mode / Xray Core",
            "Resolved tag",
        )
        assert_visible_custom_scrollbar(cdp)
        cdp.evaluate(
            """
            new Promise((resolve) => {
              document.querySelector('.binary-row')?.scrollIntoView({ block: 'start' });
              setTimeout(resolve, 200);
            })
            """,
            await_promise=True,
        )
        cdp.screenshot(output_dir / "settings-core-desktop-zh-CN.png")
        assert_advanced_xray_layout(cdp, "zh-CN")
        cdp.evaluate(
            """
            new Promise((resolve) => {
              document.querySelector('.xray-config-editor')?.scrollIntoView({ block: 'start' });
              setTimeout(resolve, 250);
            })
            """,
            await_promise=True,
        )
        cdp.screenshot(output_dir / "settings-xray-json-editor-800x540-zh-CN.png")
        text = select_settings_section(cdp, 0)
        text = switch_to_english(cdp)
        assert_contains(text, "General Settings", "Language")
        text = assert_appearance_persistence(cdp)
        assert_contains(text, "General Settings", "Language")
        assert_desktop_viewport(cdp)
        cdp.screenshot(output_dir / "settings-desktop-en.png")
        capture_fixed_window_pages(cdp, output_dir, "en")
        text = navigate_hash(cdp, "settings")
        text = select_settings_section(cdp, 1)
        assert_contains(
            text,
            "Diagnose",
            "Stable",
            "Preview",
            "Diagnostics use saved runtime settings only",
        )
        diagnostics_text = str(
            cdp.evaluate(
                """
                new Promise((resolve) => {
                  const deadline = Date.now() + 3000;
                  const read = () => {
                    const panel = document.querySelector('.release-diagnostics');
                    const text = panel?.textContent ?? '';
                    if (text.includes('Installed version') || Date.now() >= deadline) {
                      resolve(text);
                      return;
                    }
                    setTimeout(read, 100);
                  };
                  read();
                })
                """,
                await_promise=True,
            ),
        )
        assert_contains(diagnostics_text, "Installed version", "Resolved tag")
        cdp.evaluate(
            """
            new Promise((resolve) => {
              document.querySelector('.binary-row')?.scrollIntoView({ block: 'start' });
              setTimeout(resolve, 200);
            })
            """,
            await_promise=True,
        )
        cdp.screenshot(output_dir / "settings-binaries-800x540-en.png")
        assert_local_proxy_probe_panel(cdp)
        assert_advanced_xray_layout(cdp, "en")
        assert_subscription_refresh_preserves_advanced_xray(cdp)
        advanced_xray = exercise_advanced_xray_editor(cdp)
        required_states = [
            "exportPresent",
            "generatedRestored",
            "importPresent",
            "noHorizontalOverflow",
            "restoreInitiallyDisabled",
            "restoredExact",
            "syntaxVisible",
            "validSaved",
        ]
        if not all(advanced_xray.get(key) for key in required_states):
            raise AssertionError(f"advanced Xray JSON editor workflow failed: {advanced_xray}")
        expected_labels = {"Import JSON", "Export JSON", "Restore Valid", "Restore Generated"}
        if set(advanced_xray.get("actionLabels", [])) != expected_labels:
            raise AssertionError(f"advanced Xray action labels mismatch: {advanced_xray}")
        if advanced_xray.get("toggleLabel") != "Use advanced complete config":
            raise AssertionError(f"advanced Xray toggle label mismatch: {advanced_xray}")
        assert_no_horizontal_overflow(cdp)
        cdp.evaluate(
            """
            new Promise((resolve) => {
              document.querySelector('.xray-config-editor')?.scrollIntoView({ block: 'start' });
              setTimeout(resolve, 250);
            })
            """,
            await_promise=True,
        )
        cdp.screenshot(output_dir / "settings-xray-json-editor-800x540-en.png")
        text = configure_tachyon_server(cdp, "game.example.com:443")
        assert_contains(
            text,
            "Tachyon Server Profiles",
            "Smoke Game Relay",
            "TGP Local Bind Addresses",
            "TGP Connection Migration",
            "TGP Multipath",
            "Xray SOCKS",
            "Xray Stats API",
            "Tachyon IPC",
            "Tachyon gRPC",
            "TUN",
            "Telemetry",
            "Validate Configs",
        )
        if not cdp.evaluate("Boolean(document.querySelector('[data-testid=\"runtime-row-tun-privilege\"]'))"):
            raise AssertionError("stable TUN privilege runtime row is missing")
        core_summary = core_config_summary(cdp)
        if core_summary != {
            "serverAddr": "game.example.com:443",
            "tgpServerAddr": "game.example.com:443",
            "psk": "smoke-psk-012345",
            "tunAutoRoute": False,
            "tunDnsHijack": False,
        }:
            raise AssertionError(f"Core config did not use the selected Tachyon profile: {core_summary}")
        assert_no_runtime_error(text)
        text = click_validate_configs(cdp)
        assert_contains(text, "Xray", "Tachyon Core", "OK")
        assert_desktop_interaction_polish(cdp)
        assert_desktop_viewport(cdp)
        cdp.screenshot(output_dir / "settings-core-desktop-en.png")
        assert_key_pages_at_viewports(cdp, output_dir)

        assert_ui_smoke_vault_migration_and_reload(cdp)

        return {
            "status": "passed",
            "artifactDirectory": str(output_dir.resolve()),
            "edgeExecutable": str(edge_path.resolve()),
            "port": port,
            "viewport": {"width": 800, "height": 540},
            "globalRouting": {
                "selectedSubscriptionId": global_summary["selectedSubscriptionId"],
                "selectedNodeId": global_summary["selectedNodeId"],
                "selectedNodeName": global_summary["selectedNodeName"],
                "selectedNodeOutboundTag": global_summary["selectedNodeOutboundTag"],
                "selectedOutboundDescriptor": global_summary["selectedOutboundDescriptor"],
                "selectedOutboundHmac": global_summary["selectedOutboundHmac"],
                "catchAllOutboundTag": global_summary["catchAllOutboundTag"],
                "catchAllOutboundDescriptor": global_summary["catchAllOutboundDescriptor"],
                "catchAllOutboundHmac": global_summary["catchAllOutboundHmac"],
                "duplicateOutboundTags": global_summary["duplicateOutboundTags"],
                "strictSelectedTrafficOutboundMatch": (
                    global_summary["selectedNodeOutboundTag"]
                    == global_summary["catchAllOutboundTag"]
                ),
                "strictSelectedOutboundObjectMatch": global_summary["outboundObjectsMatch"],
            },
        }
    except Exception as error:
        failed = True
        for handle in (stdout_file, stderr_file):
            if handle is not None:
                handle.flush()
        collect_failure_diagnostics(
            output_dir=output_dir,
            phase=phase,
            error=error,
            edge=edge,
            endpoint=endpoint,
            user_dir=user_dir_path,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            cdp=cdp,
        )
        raise
    finally:
        cleanup_errors: list[str] = []
        if cdp is not None:
            try:
                cdp.close()
            except Exception as error:  # noqa: BLE001 - continue process-tree cleanup.
                cleanup_errors.append(f"CDP close: {type(error).__name__}")
        if edge is not None:
            try:
                stop_edge(edge)
            except Exception as error:  # noqa: BLE001 - continue port and file cleanup.
                cleanup_errors.append(f"Edge cleanup: {type(error).__name__}")
        for handle in (stdout_file, stderr_file):
            if handle is not None:
                handle.close()
        if not wait_port_released(cleanup_port):
            cleanup_errors.append("CDP port remained open after Edge tree cleanup")
        server.shutdown()
        server.server_close()
        if not wait_port_released(port):
            cleanup_errors.append("HTTP fixture port remained open after server cleanup")
        user_dir.cleanup()
        if cleanup_errors and failed:
            diagnostics_path = output_dir / "DIAGNOSTICS.json"
            try:
                diagnostics = json.loads(diagnostics_path.read_text(encoding="utf-8"))
                diagnostics["cleanupErrors"] = cleanup_errors
                write_json(diagnostics_path, diagnostics)
            except Exception:
                pass
        elif cleanup_errors:
            raise RuntimeError("; ".join(cleanup_errors))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--edge", default=str(EDGE))
    parser.add_argument("--out", default=str(ARTIFACTS))
    parser.add_argument("--port", default=1422, type=int)
    parser.add_argument("--run-label", default="ui-smoke")
    parser.add_argument("--startup-only", action="store_true")
    args = parser.parse_args()

    output_dir = Path(args.out).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    result_path = output_dir / "RESULT.json"
    error_path = output_dir / "ERROR.json"
    result_path.unlink(missing_ok=True)
    error_path.unlink(missing_ok=True)
    commit = current_git_commit(ROOT)
    try:
        edge_path = Path(args.edge).resolve()
        if not edge_path.is_file():
            raise FileNotFoundError(f"Edge executable not found: {edge_path}")
        result = {
            "gitCommit": commit,
            "runLabel": args.run_label,
            **run(
                edge_path,
                args.port,
                output_dir,
                startup_only=args.startup_only,
            ),
        }
        write_json(result_path, result)
    except Exception as error:
        write_json(
            error_path,
            {
                "status": "failed",
                "gitCommit": commit,
                "runLabel": args.run_label,
                "errorType": type(error).__name__,
                "error": sanitize_diagnostic_text(str(error)),
                "diagnostics": (
                    "DIAGNOSTICS.json"
                    if (output_dir / "DIAGNOSTICS.json").is_file()
                    else None
                ),
            },
        )
        raise
    print(f"Prism UI smoke test passed. Evidence: {result_path}")


if __name__ == "__main__":
    main()
