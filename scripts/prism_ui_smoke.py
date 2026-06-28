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
    if int(overflow["scroll"]) > int(overflow["client"]) + 2:
        raise AssertionError(f"content vertical overflow detected: {overflow}")


def assert_custom_window_chrome(cdp: CDP) -> None:
    chrome = cdp.evaluate(
        """
        (() => ({
          titlebar: Boolean(document.querySelector('.app-titlebar')),
          dragRegions: document.querySelectorAll('[data-tauri-drag-region]').length,
          actionCount: document.querySelectorAll('.window-actions button').length,
          labels: Array.from(document.querySelectorAll('.window-actions button'))
            .map((button) => button.getAttribute('aria-label'))
        }))()
        """,
    )
    if not chrome["titlebar"] or int(chrome["dragRegions"]) < 2 or int(chrome["actionCount"]) != 4:
        raise AssertionError(f"custom window chrome missing: {chrome}")
    expected = {"Pin window", "Minimize window", "Maximize window", "Close window"}
    if set(chrome["labels"]) != expected:
        raise AssertionError(f"custom window controls mismatch: {chrome}")


def assert_dual_core_chart(cdp: CDP) -> None:
    chart = cdp.evaluate(
        """
        (() => ({
          legend: Array.from(document.querySelectorAll('.legend-item'))
            .map((item) => item.textContent.trim()),
          emptyText: document.querySelector('.chart-empty')?.textContent.trim() ?? '',
          seriesClasses: Array.from(document.querySelectorAll('.legend-item'))
            .map((item) => item.className)
        }))()
        """,
    )
    labels = " ".join(chart["legend"])
    for label in ["Tachyon ↑", "Tachyon ↓", "Xray ↑", "Xray ↓"]:
        if label not in labels:
            raise AssertionError(f"dual-core traffic legend missing {label}: {chart}")
    for class_name in ["tachyon-up", "tachyon-down", "xray-up", "xray-down"]:
        if not any(class_name in item for item in chart["seriesClasses"]):
            raise AssertionError(f"dual-core traffic class missing {class_name}: {chart}")
    if not chart["emptyText"]:
        raise AssertionError(f"chart empty state missing: {chart}")


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
    return cdp.evaluate(
        """
        new Promise((resolve) => {
          location.hash = 'settings';
          setTimeout(() => {
            document.querySelectorAll('.settings-sidebar button')[1]?.click();
            setTimeout(() => {
              const raw = document.querySelector('textarea[data-config-draft="xray"]')?.value ?? '{}';
              const config = JSON.parse(raw);
              const rules = config.routing?.rules ?? [];
              const trafficRule = rules.find((rule) => rule.outboundTag !== 'tachyon-xray-api') ?? {};
              resolve({
                domainStrategy: config.routing?.domainStrategy ?? '',
                firstOutboundTag: rules[0]?.outboundTag ?? '',
                firstTrafficOutboundTag: trafficRule.outboundTag ?? '',
                hasApiRule: rules.some((rule) => rule.outboundTag === 'tachyon-xray-api'),
                hasBlockRule: rules.some((rule) => rule.outboundTag === 'tachyon-block'),
                ruleCount: rules.length
              });
            }, 350);
          }, 350);
        })
        """,
        await_promise=True,
    )


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
            "--window-size=800,540",
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
        set_viewport(cdp, 800, 540)

        text = wait_for_shell(cdp)
        assert_contains(text, "Tachyon Prism", "系统代理", "实时流量")
        assert_no_runtime_error(text)
        assert_no_horizontal_overflow(cdp)
        assert_content_fits_viewport(cdp)
        assert_custom_window_chrome(cdp)
        assert_dual_core_chart(cdp)
        cdp.screenshot(output_dir / "overview-desktop.png")
        text = open_and_close_controller(cdp)
        assert_contains(text, "策略组", "节点选择", "自动选择")
        assert_no_runtime_error(text)

        text = navigate_hash(cdp, "subscriptions")
        assert_contains(text, "订阅", "节点选择")
        assert_no_runtime_error(text)
        add_state = click_add_subscription(cdp)
        if add_state["activeTag"] != "INPUT":
            raise AssertionError(f"add subscription did not focus the form: {add_state}")
        text = import_sample_subscription(cdp)
        assert_contains(text, "Smoke", "Smoke VLESS", "Smoke Trojan", "Smoke Hysteria")
        text = import_clash_subscription(cdp)
        assert_contains(text, "Clash Smoke", "Clash Smoke VLESS", "Clash Smoke SS")
        text = choose_node(cdp, "Clash Smoke SS")
        assert_contains(text, "Clash Smoke SS", "Node selected")
        cdp.screenshot(output_dir / "subscriptions-desktop.png")

        text = navigate_hash(cdp, "configs")
        assert_contains(text, "策略组", "节点选择", "自动选择", "漏网之鱼", "Clash Smoke SS")
        assert_no_runtime_error(text)
        assert_no_horizontal_overflow(cdp)
        cdp.screenshot(output_dir / "configs-desktop.png")

        text = switch_routing_mode(cdp, "global")
        assert_contains(text, "mode selected")
        if active_routing_mode(cdp) != "global":
            raise AssertionError("global routing mode did not become active")
        summary = xray_routing_summary(cdp)
        if not summary["hasApiRule"] or summary["firstTrafficOutboundTag"] != "tachyon-proxy":
            raise AssertionError(f"global routing config mismatch: {summary}")

        text = switch_routing_mode(cdp, "direct")
        assert_contains(text, "mode selected")
        if active_routing_mode(cdp) != "direct":
            raise AssertionError("direct routing mode did not become active")
        summary = xray_routing_summary(cdp)
        if not summary["hasApiRule"] or summary["firstTrafficOutboundTag"] != "tachyon-direct":
            raise AssertionError(f"direct routing config mismatch: {summary}")

        text = switch_routing_mode(cdp, "rule")
        assert_contains(text, "mode selected")
        if active_routing_mode(cdp) != "rule":
            raise AssertionError("rule routing mode did not become active")
        summary = xray_routing_summary(cdp)
        if summary["domainStrategy"] != "IPIfNonMatch" or not summary["hasBlockRule"]:
            raise AssertionError(f"rule routing config mismatch: {summary}")
        cdp.screenshot(output_dir / "routing-modes-desktop.png")

        text = navigate_hash(cdp, "plugins")
        assert_contains(text, "插件中心", "滚动发行", "节点转换")
        assert_no_runtime_error(text)
        cdp.screenshot(output_dir / "plugins-desktop.png")

        text = navigate_hash(cdp, "settings")
        text = select_settings_section(cdp, 0)
        assert_contains(text, "个性化", "主题", "核心")
        assert_no_runtime_error(text)
        text = switch_to_english(cdp)
        assert_contains(text, "Personalization", "Theme", "Core")
        cdp.screenshot(output_dir / "settings-desktop-en.png")
        text = select_settings_section(cdp, 1)
        assert_contains(
            text,
            "Xray SOCKS",
            "Xray Stats API",
            "Tachyon IPC",
            "Tachyon gRPC",
            "TUN",
            "Telemetry",
        )
        assert_no_runtime_error(text)
        cdp.screenshot(output_dir / "settings-core-desktop-en.png")

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
