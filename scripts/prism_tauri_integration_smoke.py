from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import traceback
from contextlib import contextmanager
from ctypes import wintypes
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

from prism_ui_smoke import (
    CDP,
    QuietHandler,
    assert_advanced_xray_layout,
    assert_content_scroll_is_contained,
    assert_custom_window_chrome,
    assert_desktop_interaction_polish,
    assert_fixed_window_labels_fit,
    assert_no_horizontal_overflow,
    click_add_subscription,
    free_port,
    import_subscription_payload,
    navigate_hash,
    select_settings_section,
    start_server,
    update_all_subscriptions,
    update_subscription_url,
    wait_for_shell,
    wait_json,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EXE = ROOT / "src-tauri" / "target" / "release" / "tachyon-prism.exe"
DEFAULT_XRAY = (
    ROOT
    / "artifacts"
    / "xray-live-cache"
    / "v26.3.27"
    / "extracted"
    / "xray.exe"
)
DEFAULT_ARTIFACTS = ROOT / "artifacts" / "tauri-integration-smoke"
DEFAULT_HARD_TIMEOUT_SECONDS = 270
MAX_HARD_TIMEOUT_SECONDS = 285
CREATE_NO_WINDOW = 0x08000000
WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
GWL_STYLE = -16


def timestamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def current_head() -> str:
    completed = subprocess.run(
        [
            "git",
            "-c",
            f"safe.directory={ROOT.as_posix()}",
            "rev-parse",
            "HEAD",
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
        creationflags=CREATE_NO_WINDOW,
    )
    return completed.stdout.strip()


class RunContext:
    def __init__(self, output_dir: Path, hard_timeout_seconds: int) -> None:
        self.output_dir = output_dir
        self.log_path = output_dir / "RUN.log"
        self.started_monotonic = time.monotonic()
        self.deadline = self.started_monotonic + max(1, hard_timeout_seconds - 15)
        self.owned_processes: list[subprocess.Popen[Any]] = []
        self.result: dict[str, Any] = {
            "status": "running",
            "startedAt": timestamp(),
            "finishedAt": None,
            "durationSeconds": None,
            "hardTimeoutSeconds": hard_timeout_seconds,
            "head": None,
            "buildExecutable": None,
            "xrayBinary": None,
            "screenshots": {
                "zh-CN": {"status": "not-run", "files": [], "error": None},
                "en": {"status": "not-run", "files": [], "error": None},
            },
            "ipc": {},
            "ui": {},
            "diagnostics": {
                "steps": [],
                "windowDiscovery": [],
                "devTools": [],
                "ipcErrors": [],
                "processCleanup": [],
                "restoration": [],
                "networkSafety": {
                    "proxyEnvironmentRemoved": True,
                    "proxyCommandsInvoked": False,
                    "runtimeStartCommandsInvoked": False,
                    "tunAutoRouteRequested": False,
                    "tunDnsHijackRequested": False,
                },
            },
            "failure": None,
        }

    def log(self, message: str) -> None:
        line = f"[{timestamp()}] {message}"
        print(line, flush=True)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(line + "\n")
            handle.flush()

    def check_deadline(self, operation: str) -> None:
        if time.monotonic() >= self.deadline:
            raise TimeoutError(f"worker deadline reached during {operation}")

    def checkpoint(self) -> None:
        atomic_write_json(self.output_dir / "RESULT.json", self.result)

    @contextmanager
    def step(self, name: str) -> Iterator[None]:
        self.check_deadline(name)
        record: dict[str, Any] = {"name": name, "startedAt": timestamp(), "status": "running"}
        self.result["diagnostics"]["steps"].append(record)
        started = time.monotonic()
        self.log(f"STEP START {name}")
        try:
            yield
        except Exception as error:
            record.update(
                finishedAt=timestamp(),
                durationSeconds=round(time.monotonic() - started, 3),
                status="failed",
                error=str(error),
            )
            self.log(f"STEP FAIL {name}: {error}")
            self.checkpoint()
            raise
        else:
            record.update(
                finishedAt=timestamp(),
                durationSeconds=round(time.monotonic() - started, 3),
                status="passed",
            )
            self.log(f"STEP PASS {name}")
            self.checkpoint()

    def ipc_error(self, command: str, error: str, *, expected: bool) -> None:
        self.result["diagnostics"]["ipcErrors"].append(
            {"timestamp": timestamp(), "command": command, "expected": expected, "error": error}
        )
        label = "expected" if expected else "unexpected"
        self.log(f"IPC ERROR ({label}) {command}: {error}")
        self.checkpoint()

    def finish(self, status: str, failure: dict[str, Any] | None = None) -> None:
        self.result["status"] = status
        self.result["failure"] = failure
        self.result["finishedAt"] = timestamp()
        self.result["durationSeconds"] = round(time.monotonic() - self.started_monotonic, 3)
        atomic_write_json(self.output_dir / "RESULT.json", self.result)


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


user32 = ctypes.WinDLL("user32", use_last_error=True)
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [EnumWindowsProc, wintypes.LPARAM]
user32.EnumWindows.restype = wintypes.BOOL
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsWindowVisible.restype = wintypes.BOOL
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
user32.GetWindowRect.restype = wintypes.BOOL
user32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t


def assert_true(value: Any, message: str) -> None:
    if not value:
        raise AssertionError(message)


def find_main_window(pid: int, context: RunContext, timeout: float = 20.0) -> int:
    observation: dict[str, Any] = {
        "pid": pid,
        "startedAt": timestamp(),
        "timeoutSeconds": timeout,
        "status": "waiting",
        "visibleCandidates": [],
    }
    context.result["diagnostics"]["windowDiscovery"].append(observation)
    context.log(f"WINDOW WAIT pid={pid} timeout={timeout:.1f}s")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        context.check_deadline("window discovery")
        handles: list[int] = []

        @EnumWindowsProc
        def collect(hwnd: int, _: int) -> bool:
            owner = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value == pid and user32.IsWindowVisible(hwnd):
                rect = RECT()
                if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                    width = rect.right - rect.left
                    height = rect.bottom - rect.top
                    if width >= 780 and height >= 520:
                        handles.append(int(hwnd))
            return True

        user32.EnumWindows(collect, 0)
        if handles:
            hwnd = handles[0]
            observation.update(
                finishedAt=timestamp(),
                status="found",
                hwnd=hwnd,
                rect=window_rect(hwnd),
                visibleCandidates=handles,
            )
            context.log(f"WINDOW FOUND pid={pid} hwnd={hwnd} rect={observation['rect']}")
            context.checkpoint()
            return hwnd
        time.sleep(0.2)
    error = f"Prism main window did not appear for pid {pid} within {timeout:.1f}s"
    observation.update(finishedAt=timestamp(), status="failed", error=error)
    context.log(f"WINDOW FAIL pid={pid}: {error}")
    context.checkpoint()
    raise RuntimeError(error)


def window_rect(hwnd: int) -> dict[str, int]:
    rect = RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        raise ctypes.WinError(ctypes.get_last_error())
    return {
        "left": rect.left,
        "top": rect.top,
        "right": rect.right,
        "bottom": rect.bottom,
        "width": rect.right - rect.left,
        "height": rect.bottom - rect.top,
    }


def read_bytes(path: Path) -> bytes | None:
    return path.read_bytes() if path.is_file() else None


def restore_bytes(path: Path, contents: bytes | None) -> None:
    if contents is None:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tauri-smoke-restore")
    temporary.write_bytes(contents)
    os.replace(temporary, path)


def stop_process(
    process: subprocess.Popen[Any] | None,
    context: RunContext,
    reason: str,
) -> None:
    if process is None or process.poll() is not None:
        if process is not None:
            context.result["diagnostics"]["processCleanup"].append(
                {
                    "timestamp": timestamp(),
                    "pid": process.pid,
                    "reason": reason,
                    "status": "already-exited",
                    "exitCode": process.returncode,
                }
            )
        return
    context.log(f"PROCESS STOP pid={process.pid} reason={reason}")
    try:
        completed = subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            check=False,
            capture_output=True,
            creationflags=CREATE_NO_WINDOW,
            text=True,
            timeout=8,
        )
        taskkill_exit = completed.returncode
        taskkill_stdout = completed.stdout.strip()
        taskkill_stderr = completed.stderr.strip()
    except Exception as error:  # noqa: BLE001 - still kill the direct child below.
        taskkill_exit = None
        taskkill_stdout = ""
        taskkill_stderr = str(error)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)
    cleanup = {
        "timestamp": timestamp(),
        "pid": process.pid,
        "reason": reason,
        "status": "terminated",
        "exitCode": process.returncode,
        "taskkillExitCode": taskkill_exit,
        "taskkillStdout": taskkill_stdout,
        "taskkillStderr": taskkill_stderr,
    }
    context.result["diagnostics"]["processCleanup"].append(cleanup)
    context.log(
        f"PROCESS STOPPED pid={process.pid} exit={process.returncode} "
        f"taskkill={taskkill_exit}"
    )


def launch(
    executable: Path,
    output_dir: Path,
    context: RunContext,
) -> tuple[subprocess.Popen[Any], CDP, int]:
    context.check_deadline("launch")
    debug_port = free_port()
    devtools_url = f"http://127.0.0.1:{debug_port}/json/list"
    devtools: dict[str, Any] = {
        "timestamp": timestamp(),
        "port": debug_port,
        "url": devtools_url,
        "status": "waiting",
        "error": None,
        "tabs": [],
    }
    context.result["diagnostics"]["devTools"].append(devtools)
    context.log(f"DEVTOOLS PORT allocated={debug_port} url={devtools_url}")
    context.checkpoint()
    webview_data = output_dir / "webview2-data"
    webview_data.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    removed_proxy_variables = []
    for name in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        if env.pop(name, None) is not None:
            removed_proxy_variables.append(name)
    env["NO_PROXY"] = "127.0.0.1,localhost"
    env["no_proxy"] = "127.0.0.1,localhost"
    context.result["diagnostics"]["networkSafety"]["removedProxyVariables"] = removed_proxy_variables
    env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (
        f"--remote-debugging-address=127.0.0.1 --remote-debugging-port={debug_port} "
        "--remote-allow-origins=* --disable-background-networking"
    )
    env["WEBVIEW2_USER_DATA_FOLDER"] = str(webview_data)
    stdout_path = output_dir / "prism.stdout.log"
    stderr_path = output_dir / "prism.stderr.log"
    with stdout_path.open("ab") as stdout, stderr_path.open("ab") as stderr:
        process = subprocess.Popen(
            [str(executable)],
            cwd=str(executable.parent),
            env=env,
            stdout=stdout,
            stderr=stderr,
            creationflags=CREATE_NO_WINDOW,
        )
    context.owned_processes.append(process)
    context.log(f"PROCESS START pid={process.pid} executable={executable}")
    deadline = time.monotonic() + 30
    last_error: Exception | None = None
    tabs: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        context.check_deadline("DevTools discovery")
        if process.poll() is not None:
            error = f"Prism exited before DevTools was ready: exit code {process.returncode}"
            devtools.update(status="failed", error=error, finishedAt=timestamp())
            raise RuntimeError(error)
        try:
            tabs = wait_json(devtools_url, timeout=1.5)
            if tabs:
                break
        except Exception as error:  # noqa: BLE001 - bounded readiness loop.
            last_error = error
        time.sleep(0.2)
    if not tabs:
        error = (
            "Prism WebView2 remote debugging unavailable after 30s "
            f"on port {debug_port}: {last_error}"
        )
        devtools.update(status="failed", error=error, finishedAt=timestamp())
        context.log(f"DEVTOOLS FAIL port={debug_port}: {error}")
        context.checkpoint()
        stop_process(process, context, "DevTools unavailable")
        raise RuntimeError(error)
    devtools.update(status="ready", tabs=tabs, finishedAt=timestamp())
    context.log(f"DEVTOOLS READY port={debug_port} tabs={len(tabs)}")
    context.checkpoint()
    page = next(
        (
            item
            for item in tabs
            if item.get("type") == "page"
            and ("Tachyon Prism" in item.get("title", "") or "tauri" in item.get("url", ""))
        ),
        next(item for item in tabs if item.get("type") == "page"),
    )
    cdp = CDP(page["webSocketDebuggerUrl"])
    cdp.call("Runtime.enable")
    cdp.call("Page.enable")
    wait_for_shell(cdp)
    return process, cdp, find_main_window(process.pid, context)


def invoke(
    cdp: CDP,
    context: RunContext,
    command: str,
    arguments: dict[str, Any] | None = None,
) -> Any:
    context.check_deadline(f"IPC {command}")
    result = cdp.evaluate(
        f"""
        (async () => {{
          try {{
            const value = await window.__TAURI_INTERNALS__.invoke(
              {json.dumps(command)},
              {json.dumps(arguments or {})}
            );
            return {{ ok: true, value }};
          }} catch (error) {{
            return {{ ok: false, error: String(error) }};
          }}
        }})()
        """,
        await_promise=True,
    )
    if not result.get("ok"):
        error = str(result.get("error", f"{command} failed"))
        context.ipc_error(command, error, expected=False)
        raise RuntimeError(error)
    return result.get("value")


def invoke_failure(
    cdp: CDP,
    context: RunContext,
    command: str,
    arguments: dict[str, Any],
) -> str:
    context.check_deadline(f"IPC expected failure {command}")
    result = cdp.evaluate(
        f"""
        (async () => {{
          try {{
            const value = await window.__TAURI_INTERNALS__.invoke(
              {json.dumps(command)},
              {json.dumps(arguments)}
            );
            return {{ ok: true, value }};
          }} catch (error) {{
            return {{ ok: false, error: String(error) }};
          }}
        }})()
        """,
        await_promise=True,
    )
    if result.get("ok"):
        error = f"{command} unexpectedly succeeded"
        context.ipc_error(command, error, expected=False)
        raise AssertionError(error)
    error = str(result.get("error", ""))
    context.ipc_error(command, error, expected=True)
    return error


def set_language(cdp: CDP, language: str) -> None:
    cdp.evaluate(
        f"""
        (() => {{
          localStorage.setItem('tachyon.prism.language.v1', {json.dumps(language)});
          location.hash = 'overview';
          location.reload();
        }})()
        """
    )
    wait_for_shell(cdp)
    time.sleep(0.5)


def screenshot_pages(
    cdp: CDP,
    output_dir: Path,
    language: str,
    context: RunContext,
) -> list[str]:
    markers = {
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
    record = context.result["screenshots"][language]
    record.update(status="running", files=[], error=None)
    files: list[str] = []
    try:
        viewport = cdp.evaluate("({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })")
        assert_true(
            viewport.get("width") == 800 and viewport.get("height") == 540,
            f"{language} native WebView viewport is not 800x540: {viewport}",
        )
        record["viewport"] = viewport
        for view, marker in markers.items():
            context.check_deadline(f"{language} {view} screenshot")
            context.log(f"SCREENSHOT START language={language} view={view} viewport=800x540")
            text = navigate_hash(cdp, view)
            if view == "settings":
                cdp.evaluate("document.querySelectorAll('.settings-sidebar button')[0]?.click()")
                time.sleep(0.4)
                text = str(cdp.evaluate("document.body.innerText"))
            assert_true(marker in text, f"{language} {view} marker missing: {marker}")
            assert_no_horizontal_overflow(cdp)
            assert_content_scroll_is_contained(cdp)
            assert_fixed_window_labels_fit(cdp, view)
            path = output_dir / f"native-{view}-800x540-{language}.png"
            cdp.screenshot(path)
            files.append(path.name)
            context.log(f"SCREENSHOT PASS language={language} view={view} file={path.name}")
    except Exception as error:
        record.update(status="failed", files=files, error=str(error))
        raise
    record.update(status="passed", files=files)
    return files


def set_textarea(cdp: CDP, value: str) -> None:
    cdp.evaluate(
        f"""
        (() => {{
          const editor = document.querySelector('[data-xray-advanced-editor="enabled"]');
          if (!editor) throw new Error('advanced Xray editor missing');
          const descriptor = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(editor), 'value'
          );
          descriptor.set.call(editor, {json.dumps(value)});
          editor.dispatchEvent(new Event('input', {{ bubbles: true }}));
        }})()
        """
    )


def exercise_native_editor(
    cdp: CDP,
    canonical: str,
    imported: str,
    *,
    expect_save_success: bool,
    context: RunContext,
) -> dict[str, Any]:
    assert_advanced_xray_layout(cdp, "en")
    set_textarea(cdp, canonical)
    save_observation = cdp.evaluate(
        """
        (() => {
          const panel = document.querySelector('[data-xray-advanced-editor="enabled"]')
            ?.closest('.settings-card');
          const restore = Array.from(panel?.querySelectorAll('.xray-editor-actions button') ?? [])
            .find((button) => button.textContent.includes('Restore Valid'));
          return { restoreEnabled: Boolean(restore && !restore.disabled), text: document.body.innerText };
        })()
        """,
    )
    if expect_save_success:
        assert_true(save_observation["restoreEnabled"], "native editor did not complete real Xray save")
    save_text = str(save_observation["text"])
    save_failure_surfaced = any(
        marker in save_text
        for marker in ("Xray config validation failed", "Failed to get format", "Config save failed")
    )
    error_lines = [
        line[:500]
        for line in save_text.splitlines()
        if "fail" in line.lower() or "error" in line.lower()
    ][:8]
    context.result["diagnostics"]["editorSaveObservation"] = {
        "restoreEnabled": bool(save_observation["restoreEnabled"]),
        "failureSurfaced": save_failure_surfaced,
        "errorLines": error_lines,
    }
    if not expect_save_success and not save_failure_surfaced:
        context.log("EDITOR SAVE FINDING expected Xray validation failure was not surfaced in UI text")

    export_result = cdp.evaluate(
        """
        new Promise((resolve) => {
          const original = URL.createObjectURL;
          URL.createObjectURL = function (blob) {
            void blob.text().then((text) => {
              URL.createObjectURL = original;
              resolve({ text });
            });
            return original.call(URL, blob);
          };
          const panel = document.querySelector('[data-xray-advanced-editor="enabled"]')
            ?.closest('.settings-card');
          const button = Array.from(panel?.querySelectorAll('.xray-editor-actions button') ?? [])
            .find((item) => item.textContent.includes('Export JSON'));
          if (!button) throw new Error('Export JSON button missing');
          button.click();
          setTimeout(() => {
            URL.createObjectURL = original;
            resolve({ text: '__TIMEOUT__' });
          }, 3000);
        })
        """,
        await_promise=True,
    )
    assert_true(export_result["text"] == canonical, "export did not preserve canonical text")

    imported_value = cdp.evaluate(
        f"""
        new Promise((resolve) => {{
          const input = document.querySelector('[data-xray-json-import]');
          if (!input) throw new Error('Import JSON input missing');
          const transfer = new DataTransfer();
          transfer.items.add(new File([{json.dumps(imported)}], 'imported.json', {{ type: 'application/json' }}));
          Object.defineProperty(input, 'files', {{ configurable: true, value: transfer.files }});
          input.dispatchEvent(new Event('change', {{ bubbles: true }}));
          setTimeout(() => resolve(
            document.querySelector('[data-xray-advanced-editor="enabled"]')?.value ?? ''
          ), 500);
        }})
        """,
        await_promise=True,
    )
    assert_true(imported_value == imported, "import did not preserve file text")

    set_textarea(cdp, "{")
    restored = cdp.evaluate(
        """
        new Promise((resolve) => {
          const panel = document.querySelector('[data-xray-advanced-editor="enabled"]')
            ?.closest('.settings-card');
          const button = Array.from(panel?.querySelectorAll('.xray-editor-actions button') ?? [])
            .find((item) => item.textContent.includes('Restore Valid'));
          if (!button) throw new Error('Restore Valid button missing');
          button.click();
          setTimeout(() => resolve(
            document.querySelector('[data-xray-advanced-editor="enabled"]')?.value ?? ''
          ), 400);
        })
        """,
        await_promise=True,
    )
    assert_true(restored == canonical, "Restore Valid did not restore exact canonical text")

    generated = cdp.evaluate(
        """
        new Promise((resolve) => {
          const panel = document.querySelector('[data-xray-advanced-editor="enabled"]')
            ?.closest('.settings-card');
          const button = Array.from(panel?.querySelectorAll('.xray-editor-actions button') ?? [])
            .find((item) => item.textContent.includes('Restore Generated'));
          if (!button) throw new Error('Restore Generated button missing');
          if (button.disabled) {
            resolve({ available: false, restored: false });
            return;
          }
          button.click();
          setTimeout(() => {
            const value = document.querySelector('[data-xray-advanced-editor="enabled"]')?.value ?? '';
            try {
              resolve({ available: true, restored: Boolean(JSON.parse(value).routing) });
            } catch {
              resolve({ available: true, restored: false });
            }
          }, 400);
        })
        """,
        await_promise=True,
    )
    if generated["available"]:
        assert_true(generated["restored"], "Restore Generated did not restore generated Xray JSON")
    return {
        "saveStatus": "not-invoked-native-confirmation",
        "saveFailureSurfaced": save_failure_surfaced,
        "exportExact": True,
        "importExact": True,
        "restoreValidExact": True,
        "restoreGenerated": bool(generated["restored"]),
        "restoreGeneratedStatus": "passed" if generated["available"] else "not-available",
    }


def test_subscription(cdp: CDP, port: int) -> dict[str, Any]:
    navigate_hash(cdp, "subscriptions")
    add = click_add_subscription(cdp)
    assert_true(add.get("activeTag") == "INPUT", f"subscription form did not focus: {add}")
    text = update_subscription_url(
        cdp,
        "Native IPC Smoke",
        f"http://127.0.0.1:{port}/smoke-subscription",
    )
    assert_true(
        "Could not fetch the subscription" in text,
        "native loopback subscription rejection was not surfaced",
    )
    assert_true(
        "Smoke URL VLESS" not in text and "Smoke URL Trojan" not in text,
        "rejected loopback subscription imported nodes",
    )
    text = update_all_subscriptions(cdp)
    assert_true("No remote subscriptions" in text, "rejected subscription was persisted")
    assert_no_horizontal_overflow(cdp)
    return {"add": True, "loopbackRejected": True, "rejectedSubscriptionNotPersisted": True}


def managed_freedom_config(settings: dict[str, Any], *, compact: bool = False) -> str:
    config = {
        "log": {"loglevel": "warning"},
        "inbounds": [
            {
                "tag": "tachyon-socks",
                "listen": settings["xraySocksListen"],
                "port": settings["xraySocksPort"],
                "protocol": "socks",
                "settings": {"auth": "noauth", "udp": True},
            },
            {
                "tag": "tachyon-http",
                "listen": settings["xrayHttpListen"],
                "port": settings["xrayHttpPort"],
                "protocol": "http",
                "settings": {"allowTransparent": False},
            },
        ],
        "outbounds": [
            {"tag": "tachyon-proxy", "protocol": "freedom"},
            {"tag": "tachyon-direct", "protocol": "freedom"},
            {"tag": "tachyon-block", "protocol": "blackhole"},
        ],
        "routing": {
            "domainStrategy": "AsIs",
            "rules": [
                {
                    "type": "field",
                    "network": "tcp,udp",
                    "outboundTag": "tachyon-proxy",
                }
            ],
        },
    }
    if compact:
        return json.dumps(config, separators=(",", ":"))
    return json.dumps(config, ensure_ascii=False, indent=2) + "\n"


def wait_for_tcp_listener(process: subprocess.Popen[Any], port: int, timeout: float = 8.0) -> None:
    deadline = time.monotonic() + timeout
    last_error: OSError | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Xray upstream exited before readiness: {process.returncode}")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return
        except OSError as error:
            last_error = error
            time.sleep(0.1)
    raise RuntimeError(f"Xray upstream did not listen on 127.0.0.1:{port}: {last_error}")


def start_xray_socks_upstream(
    xray: Path,
    port: int,
    target_port: int,
    output_dir: Path,
    context: RunContext,
) -> subprocess.Popen[Any]:
    config_path = output_dir / "xray-selected-node-upstream.json"
    config_path.write_text(
        json.dumps(
            {
                "log": {"loglevel": "warning"},
                "inbounds": [
                    {
                        "tag": "selected-node-inbound",
                        "listen": "127.0.0.1",
                        "port": port,
                        "protocol": "socks",
                        "settings": {"auth": "noauth", "udp": True},
                    }
                ],
                "outbounds": [
                    {
                        "tag": "selected-node-egress",
                        "protocol": "freedom",
                        "settings": {"redirect": f"127.0.0.1:{target_port}"},
                    }
                ],
            },
            ensure_ascii=True,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    with (output_dir / "xray-selected-node.stdout.log").open("ab") as stdout, (
        output_dir / "xray-selected-node.stderr.log"
    ).open("ab") as stderr:
        process = subprocess.Popen(
            [str(xray), "run", "-config", str(config_path)],
            cwd=str(xray.parent),
            stdout=stdout,
            stderr=stderr,
            creationflags=CREATE_NO_WINDOW,
        )
    context.owned_processes.append(process)
    wait_for_tcp_listener(process, port)
    context.log(f"SELECTED NODE XRAY READY pid={process.pid} socks=127.0.0.1:{port}")
    return process


def system_proxy_mutation_snapshot(query: dict[str, Any]) -> dict[str, Any]:
    current = query.get("current") or {}
    return {
        "enabled": current.get("enabled"),
        "matchesPrism": current.get("matchesPrism"),
        "proxyServer": current.get("proxyServer"),
        "bypass": current.get("bypass"),
        "error": current.get("error"),
        "pendingTransaction": query.get("pendingTransaction"),
    }


def verify_selected_local_xray_node(
    cdp: CDP,
    context: RunContext,
    upstream_port: int,
) -> dict[str, Any]:
    navigate_hash(cdp, "subscriptions")
    add = click_add_subscription(cdp)
    assert_true(add.get("activeTag") == "INPUT", f"subscription form did not focus: {add}")
    selected_name = "Selected Local Xray E2E"
    payload = json.dumps(
        {
            "outbounds": [
                {
                    "tag": selected_name,
                    "protocol": "socks",
                    "settings": {
                        "servers": [{"address": "127.0.0.1", "port": upstream_port}]
                    },
                },
                {
                    "tag": "Unselected Local Node",
                    "protocol": "socks",
                    "settings": {"servers": [{"address": "127.0.0.1", "port": 1}]},
                },
            ]
        }
    )
    text = import_subscription_payload(cdp, "Local Xray E2E", payload)
    assert_true(selected_name in text, "local subscription did not render its selected node")
    selection = cdp.evaluate(
        f"""
        new Promise((resolve) => {{
          const tile = Array.from(document.querySelectorAll('.node-tile'))
            .find((item) => item.textContent?.includes({json.dumps(selected_name)}));
          if (!tile) throw new Error('selected local Xray node tile missing');
          tile.click();
          setTimeout(() => {{
            const current = Array.from(document.querySelectorAll('.node-tile'))
              .find((item) => item.textContent?.includes({json.dumps(selected_name)}));
            resolve({{
              nodeStillRendered: Boolean(current),
              selected: current?.classList.contains('active') ?? false,
              text: document.body.innerText
            }});
          }}, 700);
        }})
        """,
        await_promise=True,
    )
    assert_true(selected_name in selection["text"], "selected local node disappeared after click")
    assert_true(selection["nodeStillRendered"], "selected local node tile disappeared after click")
    assert_true(selection["selected"], "UI did not expose the selected local node as active")

    navigate_hash(cdp, "overview")
    current_node = cdp.evaluate(
        "document.querySelector('.current-node-card b')?.textContent?.trim() ?? ''"
    )
    assert_true(
        current_node == selected_name,
        f"Overview did not show the explicitly selected node: {current_node}",
    )
    direct_mode = cdp.evaluate(
        """
        new Promise((resolve) => {
          const button = document.querySelector('[data-routing-mode="direct"]');
          if (!button) throw new Error('direct routing mode button missing');
          button.click();
          setTimeout(() => resolve(
            document.querySelector('[data-routing-mode="direct"]')?.getAttribute('aria-pressed')
          ), 300);
        })
        """,
        await_promise=True,
    )
    assert_true(direct_mode == "true", f"direct routing mode was not selected: {direct_mode}")

    navigate_hash(cdp, "settings")
    select_settings_section(cdp, 1)
    managed_contents = str(
        cdp.evaluate("document.querySelector('textarea[data-config-draft=\"xray\"]')?.value ?? ''")
    )
    managed_config = json.loads(managed_contents)
    managed_target = next(
        (
            outbound
            for outbound in managed_config.get("outbounds") or []
            if outbound.get("tag") in {"tachyon-proxy", selected_name}
        ),
        None,
    )
    assert_true(
        managed_target is not None and managed_target.get("protocol") == "socks",
        f"managed JSON did not select the SOCKS node: {managed_target}",
    )
    managed_settings = managed_target.get("settings") or {}
    managed_server = (managed_settings.get("servers") or [{}])[0]
    assert_true(
        managed_server.get("address") == "127.0.0.1"
        and managed_server.get("port") == upstream_port,
        f"managed JSON did not preserve the UI-selected node: {managed_settings}",
    )

    vault = invoke(cdp, context, "load_secure_vault")
    selected_node_id = ((vault.get("payload") or {}).get("subscriptions") or {}).get(
        "selectedNodeId"
    )
    assert_true(bool(selected_node_id), f"secure vault did not persist selected node: {vault}")
    navigate_hash(cdp, "overview")
    proxy_before = system_proxy_mutation_snapshot(invoke(cdp, context, "system_proxy_query"))
    fixture_before = QuietHandler.request_count("/generate_204")
    click = cdp.evaluate(
        """
        (() => {
          const button = document.querySelector('.proxy-probe-panel header button');
          if (!button) return { clicked: false, reason: 'verification button missing' };
          if (button.disabled) return { clicked: false, reason: 'verification button disabled' };
          button.click();
          return { clicked: true, label: button.textContent?.trim() ?? '' };
        })()
        """
    )
    assert_true(click.get("clicked"), f"UI node verification did not start: {click}")

    deadline = time.monotonic() + 35
    ui_state = None
    while time.monotonic() < deadline:
        context.check_deadline("UI selected-node verification")
        ui_state = cdp.evaluate(
            """
            (() => ({
              panelClass: document.querySelector('.proxy-probe-panel')?.className ?? '',
              text: document.querySelector('.proxy-probe-panel')?.textContent ?? '',
              rows: Array.from(document.querySelectorAll('.proxy-probe-row')).map((row) => ({
                className: row.className,
                text: row.textContent ?? ''
              }))
            }))()
            """
        )
        if " ok" in ui_state["panelClass"] or " error" in ui_state["panelClass"]:
            break
        time.sleep(0.2)
    assert_true(ui_state is not None, "UI verification state was unavailable")
    if " ok" not in ui_state["panelClass"]:
        diagnostic = {
            "ui": ui_state,
            "managedConfig": managed_config,
            "generation": invoke(cdp, context, "xray_generation_status"),
            "runtime": invoke(cdp, context, "runtime_status"),
            "logs": invoke(cdp, context, "runtime_process_logs", {"kind": "xray"}),
        }
        raise AssertionError(f"UI verification failed: {diagnostic}")
    assert_true(
        len(ui_state["rows"]) == 2
        and all(" ok" in row["className"] for row in ui_state["rows"]),
        f"HTTP/SOCKS rows were not both successful: {ui_state}",
    )
    fixture_after = QuietHandler.request_count("/generate_204")
    assert_true(
        fixture_after - fixture_before >= 2,
        f"dual proxies did not both reach the fixture: before={fixture_before}, after={fixture_after}",
    )

    generation = invoke(cdp, context, "xray_generation_status")
    desired = generation.get("desired") or {}
    digest = str(desired.get("configSha256") or "")
    assert_true(desired.get("nodeId") == selected_node_id, f"generation node identity mismatch: {generation}")
    assert_true(
        len(digest) == 64 and desired.get("routingRevision") == digest,
        f"generation config identity mismatch: {generation}",
    )
    assert_true(
        generation.get("active") is None
        and generation.get("proxyGeneration") is None
        and generation.get("proxyReady") is False,
        f"isolated verification left runtime state: {generation}",
    )

    proxy_after = system_proxy_mutation_snapshot(invoke(cdp, context, "system_proxy_query"))
    assert_true(
        proxy_after == proxy_before,
        f"isolated verification mutated system proxy state: before={proxy_before}, after={proxy_after}",
    )
    return {
        "status": "passed",
        "nodeId": selected_node_id,
        "configDigest": digest,
        "requestTokenBound": True,
        "routingMode": "direct",
        "selectedOutbound": "socks",
        "selectedNodePort": upstream_port,
        "http": True,
        "socks": True,
        "fixtureRequests": fixture_after - fixture_before,
        "systemProxyUnchanged": True,
    }


def run_worker(executable: Path, xray: Path, output_dir: Path, timeout: int) -> int:
    output_dir.mkdir(parents=True, exist_ok=True)
    context = RunContext(output_dir, timeout)
    context.result["buildExecutable"] = {"path": str(executable)}
    context.result["xrayBinary"] = {"path": str(xray)}
    atomic_write_json(output_dir / "RESULT.json", context.result)
    context.log(f"WORKER START pid={os.getpid()} hard-timeout={timeout}s")

    server = None
    cdp: CDP | None = None
    config_backups: dict[Path, bytes | None] = {}
    status = "failed"
    failure: dict[str, Any] | None = None
    findings: list[str] = []
    secret = "TAURI_SMOKE_SECRET_9c0f"
    valid_config = ""
    imported_config = (
        '{\n  "log": {"loglevel":"error"},\n'
        '  "inbounds": [],\n'
        '  "outbounds": [{"protocol":"freedom","tag":"direct"}]\n}\n'
    )

    try:
        with context.step("verify HEAD, release executable, and official Xray cache"):
            if not executable.is_file():
                raise FileNotFoundError(f"Prism executable not found: {executable}")
            if not xray.is_file():
                raise FileNotFoundError(f"Xray executable not found: {xray}")
            head = current_head()
            context.result["head"] = head
            executable_stat = executable.stat()
            xray_stat = xray.stat()
            context.result["buildExecutable"].update(
                sha256=sha256(executable),
                size=executable_stat.st_size,
                modifiedAt=datetime.fromtimestamp(executable_stat.st_mtime).astimezone().isoformat(),
            )
            cache_root = (ROOT / "artifacts" / "xray-live-cache").resolve()
            xray_from_official_cache = xray == cache_root or cache_root in xray.parents
            version = subprocess.run(
                [str(xray), "version"],
                check=True,
                capture_output=True,
                text=True,
                timeout=8,
                creationflags=CREATE_NO_WINDOW,
            ).stdout.strip()
            context.result["xrayBinary"].update(
                sha256=sha256(xray),
                size=xray_stat.st_size,
                modifiedAt=datetime.fromtimestamp(xray_stat.st_mtime).astimezone().isoformat(),
                fromOfficialCache=xray_from_official_cache,
                version=version.splitlines()[0] if version else "",
            )
            assert_true(xray_from_official_cache, f"Xray is not from official cache: {xray}")
            context.log(f"HEAD {head}")
            context.log(f"XRAY {context.result['xrayBinary']['version']}")

        with context.step("start local subscription fixture"):
            server_port = free_port()
            server = start_server(server_port)
            context.result["diagnostics"]["fixturePort"] = server_port
            context.log(f"FIXTURE READY port={server_port}")

        with context.step("launch release executable and discover native window/DevTools"):
            process, cdp, hwnd = launch(executable, output_dir, context)

        with context.step("capture zh-CN and en native 800x540 screenshots"):
            set_language(cdp, "zh-CN")
            assert_custom_window_chrome(cdp)
            assert_desktop_interaction_polish(cdp)
            screenshot_pages(cdp, output_dir, "zh-CN", context)
            set_language(cdp, "en")
            screenshot_pages(cdp, output_dir, "en", context)
            style = int(user32.GetWindowLongPtrW(hwnd, GWL_STYLE))
            caption_absent = (style & WS_CAPTION) == 0
            thickframe_absent = (style & WS_THICKFRAME) == 0
            context.result["diagnostics"]["nativeWindowStyle"] = {
                "value": f"{style:#x}",
                "captionAbsent": caption_absent,
                "resizableFrameAbsent": thickframe_absent,
                "note": "Recorded as native integration evidence; DOM custom-chrome assertions are authoritative.",
            }
            assert_true(caption_absent, f"native WS_CAPTION is still present: style={style:#x}")
            assert_true(
                thickframe_absent,
                f"native WS_THICKFRAME is still present: style={style:#x}",
            )
            context.result["ui"].update(
                zh800x540=True,
                en800x540=True,
                noHorizontalOverflow=True,
                contentScrollable=True,
                customChrome=True,
                bodyTextNotSelectable=True,
                formTextSelectable=True,
                customScrollbar=True,
                nativeCaptionAbsent=caption_absent,
                nativeResizableFrameAbsent=thickframe_absent,
                titlebarDragRegionWired=True,
            )

        with context.step("discover IPC paths, back up user state, and disable TUN settings"):
            paths = invoke(cdp, context, "config_paths")
            runtime_paths = invoke(cdp, context, "runtime_paths")
            canonical_path = Path(paths["xrayConfigPath"])
            settings_path = Path(runtime_paths["runtimeSettingsPath"])
            config_backups = {
                canonical_path: read_bytes(canonical_path),
                settings_path: read_bytes(settings_path),
                settings_path.parent / "secure-vault.v1.json": read_bytes(
                    settings_path.parent / "secure-vault.v1.json"
                ),
            }
            context.result["configPaths"] = paths
            settings = invoke(cdp, context, "runtime_settings")
            settings["xrayBinaryPath"] = str(xray)
            xray_proxy_ports = {free_port(), free_port()}
            while len(xray_proxy_ports) < 2:
                xray_proxy_ports.add(free_port())
            settings["xraySocksPort"], settings["xrayHttpPort"] = sorted(xray_proxy_ports)
            context.result["diagnostics"]["xrayProxyPorts"] = {
                "socks": settings["xraySocksPort"],
                "http": settings["xrayHttpPort"],
            }
            settings["xrayStatsEnabled"] = False
            settings["xrayEgressProbeUrl"] = ""
            settings["tachyonTunAutoRoute"] = False
            settings["tachyonTunDnsHijack"] = False
            saved_settings = invoke(cdp, context, "save_runtime_settings", {"settings": settings})
            cdp.evaluate("location.reload()")
            wait_for_shell(cdp)
            valid_config = managed_freedom_config(saved_settings)
            assert_true(not saved_settings["tachyonTunAutoRoute"], "TUN auto-route remained enabled")
            assert_true(not saved_settings["tachyonTunDnsHijack"], "TUN DNS hijack remained enabled")
            runtime_status = invoke(cdp, context, "runtime_status")
            context.result["diagnostics"]["runtimeStatusBeforeIPC"] = runtime_status

        with context.step("validate real Xray and exercise IPC save/rollback/redaction"):
            live_config = canonical_path.parent / "tauri-smoke-live-validation.json"
            live_config.parent.mkdir(parents=True, exist_ok=True)
            live_config.write_text(valid_config, encoding="utf-8")
            try:
                live_validation = invoke(
                    cdp,
                    context,
                    "validate_xray_config",
                    {"binaryPath": str(xray), "configPath": str(live_config)},
                )
            finally:
                live_config.unlink(missing_ok=True)
            assert_true(live_validation.get("ok"), f"real Xray rejected valid JSON: {live_validation}")

            commit_succeeded = True
            commit_error = ""
            try:
                commit_paths = invoke(
                    cdp,
                    context,
                    "commit_validated_xray_config",
                    {"contents": valid_config},
                )
                assert_true(commit_paths["xrayConfigPath"] == str(canonical_path), "canonical path changed")
            except RuntimeError as error:
                commit_succeeded = False
                commit_error = str(error)
                assert_true(
                    "Failed to get format" in commit_error and ".tmp" in commit_error,
                    f"unexpected valid commit failure: {commit_error}",
                )
                restore_bytes(canonical_path, valid_config.encode("utf-8"))
                context.log("IPC valid save hit known atomic-replace failure; seeded canonical for remaining checks")
                findings.append("real IPC valid save failed because Xray could not infer the .tmp candidate format")
            first_read = invoke(cdp, context, "read_canonical_xray_config")
            assert_true(first_read == {"exists": True, "contents": valid_config}, "valid commit mismatch")

            selected_node_port = free_port()
            start_xray_socks_upstream(xray, selected_node_port, server_port, output_dir, context)
            context.result["diagnostics"]["networkSafety"]["isolatedXrayVerificationInvoked"] = True
            verification_e2e = verify_selected_local_xray_node(
                cdp,
                context,
                selected_node_port,
            )
            after_verification = invoke(cdp, context, "read_canonical_xray_config")
            assert_true(after_verification == first_read, "isolated verification changed canonical config")
            after_verification_runtime = invoke(cdp, context, "runtime_status")
            assert_true(
                after_verification_runtime["xray"]["state"] == "stopped",
                f"temporary Xray remained active: {after_verification_runtime['xray']}",
            )
            context.result["diagnostics"]["networkSafety"]["runtimeStartCommandsInvoked"] = True
            authorized_start = invoke(
                cdp,
                context,
                "start_xray",
                {"binaryPath": str(xray), "configPath": str(canonical_path)},
            )
            assert_true(authorized_start["state"] == "running", "restored authorization did not start Xray")
            authorized_stop = invoke(cdp, context, "stop_xray")
            assert_true(
                authorized_stop["state"] == "stopped" and authorized_stop["pid"] is None,
                f"authorization check did not stop Xray: {authorized_stop}",
            )
            context.result["ipc"]["isolatedNodeVerification"] = {
                **verification_e2e,
                "authorizationRestored": True,
                "canonicalUnchanged": True,
                "xrayStopped": True,
            }

            invalid_error = invoke_failure(
                cdp,
                context,
                "commit_validated_xray_config",
                {"contents": '{"log": {"loglevel": "warning"}, "outbounds": ['},
            )
            after_invalid = invoke(cdp, context, "read_canonical_xray_config")
            assert_true(after_invalid["contents"] == valid_config, "invalid config replaced canonical")

            oversize = '{"padding":"' + ("x" * (2 * 1024 * 1024)) + '"}'
            oversize_error = invoke_failure(
                cdp,
                context,
                "commit_validated_xray_config",
                {"contents": oversize},
            )
            assert_true("2097152" in oversize_error or "2" in oversize_error, "size error lacks limit")
            after_oversize = invoke(cdp, context, "read_canonical_xray_config")
            assert_true(after_oversize["contents"] == valid_config, "oversize config replaced canonical")

            secret_config = canonical_path.parent / f"auth={secret}.json"
            secret_config.write_text('{"outbounds": [}', encoding="utf-8")
            try:
                redaction = invoke(
                    cdp,
                    context,
                    "validate_xray_config",
                    {"binaryPath": str(xray), "configPath": str(secret_config)},
                )
            finally:
                secret_config.unlink(missing_ok=True)
            redaction_text = json.dumps(redaction, ensure_ascii=False)
            assert_true(secret not in redaction_text, "secret leaked from Tauri IPC validation diagnostic")
            assert_true("<redacted>" in redaction_text, "redaction marker missing from validation diagnostic")
            context.result["ipc"].update(
                validJsonAcceptedByRealXray=True,
                validCommitExact=commit_succeeded,
                validCommitError=commit_error,
                canonicalSeededExternallyAfterCommitFailure=not commit_succeeded,
                invalidRollback=True,
                invalidError=invalid_error,
                oversizeRejected=True,
                oversizeError=oversize_error,
                diagnosticRedacted=True,
            )

        with context.step("exercise native editor and subscription IPC"):
            set_language(cdp, "en")
            try:
                editor = exercise_native_editor(
                    cdp,
                    valid_config,
                    imported_config,
                    expect_save_success=commit_succeeded,
                    context=context,
                )
            except Exception as error:  # noqa: BLE001 - restart recovery must still run.
                editor = {
                    "status": "failed",
                    "error": str(error),
                    "saveFailureSurfaced": context.result["diagnostics"]
                    .get("editorSaveObservation", {})
                    .get("failureSurfaced", False),
                }
                findings.append(f"native editor workflow failed: {error}")
                context.log(f"EDITOR WORKFLOW FAIL: {error}")
            cdp.evaluate("document.querySelector('.xray-config-editor')?.scrollIntoView({block:'start'})")
            time.sleep(0.3)
            cdp.screenshot(output_dir / "native-settings-xray-editor-800x540-en.png")
            try:
                subscription = test_subscription(cdp, server_port)
                cdp.screenshot(output_dir / "native-subscriptions-loaded-800x540-en.png")
            except Exception as error:  # noqa: BLE001 - restart recovery must still run.
                subscription = {"status": "failed", "error": str(error)}
                findings.append(f"native subscription IPC workflow failed: {error}")
                context.log(f"SUBSCRIPTION WORKFLOW FAIL: {error}")
            context.result["ui"].update(advancedEditor=editor, subscription=subscription)
            if not commit_succeeded and not editor.get("saveFailureSurfaced", False):
                findings.append("native editor did not surface the real IPC save failure in visible UI text")

        with context.step("restart release executable and verify canonical recovery"):
            cdp.close()
            cdp = None
            stop_process(process, context, "controlled restart")
            process, cdp, _ = launch(executable, output_dir, context)
            restarted = invoke(cdp, context, "read_canonical_xray_config")
            assert_true(restarted == {"exists": True, "contents": valid_config}, "restart restore mismatch")
            context.result["ipc"]["restartExact"] = True

        context.result["findings"] = findings
        if findings:
            status = "failed"
            failure = {"type": "IntegrationFindings", "message": "; ".join(findings)}
        else:
            status = "passed"
    except BaseException as error:  # noqa: BLE001 - always persist failure diagnostics.
        failure = {
            "type": type(error).__name__,
            "message": str(error),
            "traceback": traceback.format_exc(),
        }
        context.log(f"WORKER FAIL {type(error).__name__}: {error}")
        for language, record in context.result["screenshots"].items():
            if record["status"] in {"not-run", "running"}:
                record.update(status="failed", error=f"blocked by {type(error).__name__}: {error}")
    finally:
        if cdp is not None:
            try:
                cdp.close()
            except Exception as error:  # noqa: BLE001 - cleanup must continue.
                context.log(f"CDP CLOSE FAIL: {error}")
        for owned in reversed(context.owned_processes):
            try:
                stop_process(owned, context, "worker finally")
            except Exception as error:  # noqa: BLE001 - cleanup must continue.
                context.log(f"PROCESS CLEANUP FAIL pid={owned.pid}: {error}")
                if failure is None:
                    failure = {"type": type(error).__name__, "message": str(error)}
                    status = "failed"
        if server is not None:
            try:
                server.shutdown()
                server.server_close()
                context.log("FIXTURE STOPPED")
            except Exception as error:  # noqa: BLE001 - state restoration still has priority.
                context.log(f"FIXTURE STOP FAIL: {error}")
        for path, contents in config_backups.items():
            restoration: dict[str, Any] = {"path": str(path), "timestamp": timestamp()}
            try:
                restore_bytes(path, contents)
                restored = read_bytes(path)
                assert_true(restored == contents, f"restored bytes differ: {path}")
                restoration["status"] = "restored"
                context.log(f"STATE RESTORED path={path}")
            except Exception as error:  # noqa: BLE001 - report every failed restore.
                restoration.update(status="failed", error=str(error))
                context.log(f"STATE RESTORE FAIL path={path}: {error}")
                if failure is None:
                    failure = {"type": type(error).__name__, "message": str(error)}
                    status = "failed"
            context.result["diagnostics"]["restoration"].append(restoration)
        context.finish(status, failure)
        context.log(f"WORKER RESULT status={status} file={output_dir / 'RESULT.json'}")
    return 0 if status == "passed" else 1


def load_result(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def terminate_supervised_worker(worker: subprocess.Popen[Any]) -> None:
    try:
        subprocess.run(
            ["taskkill", "/PID", str(worker.pid), "/T", "/F"],
            check=False,
            capture_output=True,
            text=True,
            timeout=8,
            creationflags=CREATE_NO_WINDOW,
        )
    except Exception:
        pass
    try:
        worker.wait(timeout=3)
    except subprocess.TimeoutExpired:
        worker.kill()
        worker.wait(timeout=2)


def supervise(executable: Path, xray: Path, output_dir: Path, timeout: int) -> int:
    output_dir.mkdir(parents=True, exist_ok=True)
    for path in output_dir.glob("native-*.png"):
        path.unlink(missing_ok=True)
    for path in (output_dir / "RUN.log", output_dir / "prism.stdout.log", output_dir / "prism.stderr.log"):
        path.unlink(missing_ok=True)

    supervisor = RunContext(output_dir, timeout)
    supervisor.log(f"SUPERVISOR START pid={os.getpid()} hard-timeout={timeout}s")
    atomic_write_json(output_dir / "RESULT.json", supervisor.result)
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--worker",
        "--timeout",
        str(timeout),
        "--executable",
        str(executable),
        "--xray",
        str(xray),
        "--artifacts",
        str(output_dir),
    ]
    worker = subprocess.Popen(command, cwd=ROOT, creationflags=CREATE_NO_WINDOW)
    supervisor.log(f"SUPERVISOR WORKER pid={worker.pid}")
    timed_out = False
    supervisor_error: BaseException | None = None
    try:
        worker.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        supervisor.log(f"SUPERVISOR TIMEOUT worker={worker.pid} after={timeout}s")
        terminate_supervised_worker(worker)
    except BaseException as error:  # noqa: BLE001 - never orphan the owned process tree.
        supervisor_error = error
        supervisor.log(f"SUPERVISOR FAIL {type(error).__name__}: {error}")
        terminate_supervised_worker(worker)

    result_path = output_dir / "RESULT.json"
    result = load_result(result_path) or supervisor.result
    diagnostics = result.setdefault("diagnostics", {})
    diagnostics["supervisor"] = {
        "pid": os.getpid(),
        "workerPid": worker.pid,
        "workerExitCode": worker.returncode,
        "timedOut": timed_out,
        "hardTimeoutSeconds": timeout,
        "finishedAt": timestamp(),
    }
    if timed_out:
        result["status"] = "timed-out"
        result["finishedAt"] = timestamp()
        result["failure"] = {
            "type": "TimeoutError",
            "message": f"global hard timeout reached after {timeout}s; worker process tree terminated",
        }
        for language, record in result.get("screenshots", {}).items():
            if record.get("status") in {"not-run", "running"}:
                record.update(status="failed", error=result["failure"]["message"])
    elif supervisor_error is not None:
        result["status"] = "failed"
        result["finishedAt"] = timestamp()
        result["failure"] = {
            "type": type(supervisor_error).__name__,
            "message": str(supervisor_error),
        }
    elif result.get("status") == "running":
        result["status"] = "failed"
        result["finishedAt"] = timestamp()
        result["failure"] = {
            "type": "WorkerExitError",
            "message": f"worker exited {worker.returncode} without a final result",
        }
    atomic_write_json(result_path, result)
    supervisor.log(f"SUPERVISOR RESULT status={result.get('status')} worker-exit={worker.returncode}")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("status") == "passed" else 1


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    parser = argparse.ArgumentParser(description="Prism packaged Tauri/Xray integration smoke")
    parser.add_argument("--executable", type=Path, default=DEFAULT_EXE)
    parser.add_argument("--xray", type=Path, default=DEFAULT_XRAY)
    parser.add_argument("--artifacts", type=Path, default=DEFAULT_ARTIFACTS)
    parser.add_argument("--timeout", type=int, default=DEFAULT_HARD_TIMEOUT_SECONDS)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not 30 <= args.timeout <= MAX_HARD_TIMEOUT_SECONDS:
        parser.error(f"--timeout must be between 30 and {MAX_HARD_TIMEOUT_SECONDS} seconds")
    executable = args.executable.resolve()
    xray = args.xray.resolve()
    output_dir = args.artifacts.resolve()
    if args.worker:
        return run_worker(executable, xray, output_dir, args.timeout)
    return supervise(executable, xray, output_dir, args.timeout)


if __name__ == "__main__":
    raise SystemExit(main())
