from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import tempfile
import threading
import time
import urllib.request
import socket
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from PIL import Image, ImageStat
import websocket


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
ARTIFACTS = ROOT / "artifacts" / "ui-smoke"
EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return

    def handle_one_request(self) -> None:
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError):
            return


class CDP:
    def __init__(self, url: str) -> None:
        self.ws = websocket.create_connection(url, timeout=10)
        self.next_id = 1

    def close(self) -> None:
        self.ws.close()

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        message_id = self.next_id
        self.next_id += 1
        self.ws.send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
        while True:
            raw = self.ws.recv()
            payload = json.loads(raw)
            if payload.get("id") != message_id:
                continue
            if "error" in payload:
                raise RuntimeError(f"{method}: {payload['error']}")
            return payload.get("result", {})

    def evaluate(self, expression: str, *, await_promise: bool = False) -> Any:
        result = self.call(
            "Runtime.evaluate",
            {
                "awaitPromise": await_promise,
                "expression": expression,
                "returnByValue": True,
            },
        )
        if "exceptionDetails" in result:
            raise RuntimeError(json.dumps(result["exceptionDetails"], ensure_ascii=False))
        return result.get("result", {}).get("value")

    def screenshot(self, path: Path) -> None:
        data = self.call("Page.captureScreenshot", {"format": "png", "fromSurface": True})["data"]
        path.write_bytes(base64.b64decode(data))
        assert_nonblank_png(path)


def assert_nonblank_png(path: Path) -> None:
    with Image.open(path) as image:
        stat = ImageStat.Stat(image.convert("RGB"))
        spread = sum(max(channel) - min(channel) for channel in stat.extrema)
        if image.width < 100 or image.height < 100 or spread < 30:
            raise AssertionError(f"screenshot looks blank: {path}")


def free_port() -> int:
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


def wait_json(url: str, timeout: float = 10.0) -> Any:
    deadline = time.time() + timeout
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as error:  # noqa: BLE001 - diagnostic retry loop.
            last_error = error
            time.sleep(0.2)
    raise RuntimeError(f"timed out waiting for {url}: {last_error}")


def page_text(cdp: CDP) -> str:
    return str(cdp.evaluate("document.body.innerText"))


def wait_for_shell(cdp: CDP) -> str:
    deadline = time.time() + 8
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            return str(
                cdp.evaluate(
                    """
                    new Promise((resolve) => {
                      const started = Date.now();
                      const tick = () => {
                        if (document.querySelector('.prism-shell')) {
                          resolve(document.body.innerText);
                          return;
                        }
                        if (Date.now() - started > 6000) {
                          resolve('__TIMEOUT__');
                          return;
                        }
                        setTimeout(tick, 50);
                      };
                      tick();
                    })
                    """,
                    await_promise=True,
                ),
            )
        except RuntimeError as error:
            last_error = error
            if "Execution context was destroyed" not in str(error):
                raise
            time.sleep(0.2)
    raise RuntimeError(f"shell did not become ready: {last_error}")


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


def import_sample_subscription(cdp: CDP) -> str:
    sample = "\n".join(
        [
            "vless://test-uuid@example.com:443?encryption=none&security=reality&type=tcp&sni=www.cloudflare.com&fp=chrome&pbk=public-key&sid=01#Smoke VLESS",
            "trojan://password@example.org:443?security=tls&sni=example.org#Smoke Trojan",
            "hysteria2://secret@example.net:443?sni=game.example.net&insecure=1#Smoke Hysteria",
        ],
    )
    return str(
        cdp.evaluate(
            f"""
            new Promise((resolve) => {{
              const setValue = (element, value) => {{
                const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
                descriptor.set.call(element, value);
                element.dispatchEvent(new Event('input', {{ bubbles: true }}));
              }};
              setValue(document.querySelector('input[placeholder="订阅名称"], input[placeholder="Subscription name"]'), 'Smoke');
              setValue(document.querySelector('textarea'), {json.dumps(sample)});
              const button = Array.from(document.querySelectorAll('button')).find((item) =>
                item.textContent.trim() === '导入' || item.textContent.trim() === 'Import'
              );
              button.click();
              setTimeout(() => resolve(document.body.innerText), 600);
            }})
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


def run(edge_path: Path, port: int, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    server = start_server(port)
    debug_port = free_port()
    user_dir = tempfile.TemporaryDirectory(prefix="tachyon-prism-edge-")
    edge = subprocess.Popen(
        [
            str(edge_path),
            "--headless=new",
            "--disable-background-networking",
            "--disable-extensions",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-default-browser-check",
            "--no-first-run",
            f"--remote-debugging-port={debug_port}",
            "--remote-allow-origins=*",
            f"--user-data-dir={user_dir.name}",
            "--window-size=1120,720",
            f"http://127.0.0.1:{port}/",
        ],
        stderr=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        text=True,
    )

    cdp: CDP | None = None
    try:
        tabs = wait_json(f"http://127.0.0.1:{debug_port}/json/list")
        page = next(item for item in tabs if item.get("type") == "page")
        cdp = CDP(page["webSocketDebuggerUrl"])
        cdp.call("Runtime.enable")
        cdp.call("Page.enable")

        text = wait_for_shell(cdp)
        assert_contains(text, "Tachyon Prism", "系统代理", "实时流量")
        assert_no_runtime_error(text)
        assert_no_horizontal_overflow(cdp)
        cdp.screenshot(output_dir / "overview-desktop.png")

        text = navigate_hash(cdp, "subscriptions")
        assert_contains(text, "订阅", "节点选择")
        assert_no_runtime_error(text)
        text = import_sample_subscription(cdp)
        assert_contains(text, "Smoke", "Smoke VLESS", "Smoke Trojan", "Smoke Hysteria")
        cdp.screenshot(output_dir / "subscriptions-desktop.png")

        text = navigate_hash(cdp, "plugins")
        assert_contains(text, "插件中心", "滚动发行", "节点转换")
        assert_no_runtime_error(text)
        cdp.screenshot(output_dir / "plugins-desktop.png")

        text = navigate_hash(cdp, "settings")
        assert_contains(text, "个性化", "主题", "核心")
        assert_no_runtime_error(text)
        text = switch_to_english(cdp)
        assert_contains(text, "Personalization", "Theme", "Core")
        cdp.screenshot(output_dir / "settings-desktop-en.png")

        set_viewport(cdp, 390, 844)
        text = navigate_hash(cdp, "overview")
        assert_contains(text, "System Proxy", "Realtime Traffic")
        assert_no_runtime_error(text)
        assert_no_horizontal_overflow(cdp)
        cdp.screenshot(output_dir / "overview-mobile-en.png")

        print(f"Prism UI smoke test passed. Artifacts: {output_dir}")
    finally:
        if cdp is not None:
            cdp.close()
        edge.terminate()
        try:
            edge.wait(timeout=5)
        except subprocess.TimeoutExpired:
            edge.kill()
        server.shutdown()
        user_dir.cleanup()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--edge", default=str(EDGE))
    parser.add_argument("--out", default=str(ARTIFACTS))
    parser.add_argument("--port", default=1422, type=int)
    args = parser.parse_args()

    edge_path = Path(args.edge)
    if not edge_path.is_file():
        raise SystemExit(f"Edge executable not found: {edge_path}")

    run(edge_path, args.port, Path(args.out))


if __name__ == "__main__":
    main()
