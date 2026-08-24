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
    parse_devtools_active_port,
    read_json,
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
WORKER_STEP_NAMES = (
    "verify HEAD, release executable, and official Xray cache",
    "start local subscription fixture",
    "launch release executable and discover native window/DevTools",
    "capture zh-CN and en native 800x540 screenshots",
    "discover IPC paths, back up user state, and disable TUN settings",
    "validate real Xray and exercise IPC save/rollback/redaction",
    "exercise native editor and subscription IPC",
    "restart release executable and verify canonical recovery",
)
CREATE_NO_WINDOW = 0x08000000
WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
GWL_STYLE = -16
TH32CS_SNAPPROCESS = 0x00000002
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]


class UNICODE_STRING(ctypes.Structure):
    _fields_ = [
        ("Length", wintypes.USHORT),
        ("MaximumLength", wintypes.USHORT),
        ("Buffer", wintypes.LPWSTR),
    ]


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
            "ipc": {
                "status": "not-run",
                "isolatedNodeVerification": {"status": "not-run"},
            },
            "ui": {"status": "not-run"},
            "diagnostics": {
                "steps": [
                    {
                        "name": name,
                        "status": "not-run",
                        "startedAt": None,
                        "finishedAt": None,
                        "durationSeconds": None,
                    }
                    for name in WORKER_STEP_NAMES
                ],
                "windowDiscovery": [],
                "devTools": [],
                "ipcErrors": [],
                "processCleanup": [],
                "restoration": [],
                "networkSafety": {
                    "proxyEnvironmentRemoved": True,
                    "proxyCommandsInvoked": None,
                    "systemProxyAudit": {"status": "not-captured"},
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
        record = next(
            (item for item in self.result["diagnostics"]["steps"] if item["name"] == name),
            None,
        )
        if record is None:
            raise RuntimeError(f"unregistered native E2E step: {name}")
        if record["status"] != "not-run":
            raise RuntimeError(f"native E2E step entered twice: {name}")
        record.update(startedAt=timestamp(), status="running")
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
        for record in self.result["diagnostics"]["steps"]:
            if record["status"] == "running":
                record.update(
                    status="failed",
                    finishedAt=timestamp(),
                    error=(failure or {}).get("message", "worker stopped during step"),
                )
        for section in ("ipc", "ui"):
            if self.result[section].get("status") == "running":
                self.result[section]["status"] = "failed"
        isolated = self.result["ipc"].get("isolatedNodeVerification")
        if isinstance(isolated, dict) and isolated.get("status") == "running":
            isolated["status"] = "failed"
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


def windows_process_tree(root_pid: int) -> dict[str, Any]:
    if os.name != "nt":
        return {"status": "unsupported", "rootPid": root_pid, "processes": []}
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32FirstW.restype = wintypes.BOOL
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32NextW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot == INVALID_HANDLE_VALUE:
        return {
            "status": "failed",
            "rootPid": root_pid,
            "error": f"CreateToolhelp32Snapshot: {ctypes.WinError(ctypes.get_last_error())}",
            "processes": [],
        }
    entries: dict[int, dict[str, Any]] = {}
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        current = bool(kernel32.Process32FirstW(snapshot, ctypes.byref(entry)))
        while current:
            pid = int(entry.th32ProcessID)
            entries[pid] = {
                "pid": pid,
                "parentPid": int(entry.th32ParentProcessID),
                "name": entry.szExeFile,
                "commandLine": None,
            }
            current = bool(kernel32.Process32NextW(snapshot, ctypes.byref(entry)))
    finally:
        kernel32.CloseHandle(snapshot)

    descendants = {root_pid}
    changed = True
    while changed:
        changed = False
        for pid, entry in entries.items():
            if pid not in descendants and entry["parentPid"] in descendants:
                descendants.add(pid)
                changed = True
    processes = [entries[pid] for pid in sorted(descendants) if pid in entries]
    command_line_errors = []
    for entry in processes:
        try:
            entry["commandLine"] = windows_process_command_line(entry["pid"])
        except OSError as error:
            command_line_errors.append(f"pid={entry['pid']}: {error}")
    return {
        "status": "captured",
        "rootPid": root_pid,
        "commandLineErrors": command_line_errors,
        "processes": processes,
    }


def windows_process_command_line(pid: int) -> str:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll")
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    ntdll.NtQueryInformationProcess.argtypes = [
        wintypes.HANDLE,
        wintypes.ULONG,
        wintypes.LPVOID,
        wintypes.ULONG,
        ctypes.POINTER(wintypes.ULONG),
    ]
    ntdll.NtQueryInformationProcess.restype = ctypes.c_long
    handle = kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        required = wintypes.ULONG()
        ntdll.NtQueryInformationProcess(handle, 60, None, 0, ctypes.byref(required))
        if required.value < ctypes.sizeof(UNICODE_STRING):
            raise OSError("process command line size unavailable")
        buffer = ctypes.create_string_buffer(required.value)
        status = ntdll.NtQueryInformationProcess(
            handle, 60, buffer, required.value, ctypes.byref(required)
        )
        if status < 0:
            raise OSError(f"NtQueryInformationProcess status=0x{status & 0xFFFFFFFF:08x}")
        value = UNICODE_STRING.from_buffer(buffer)
        if not value.Buffer or value.Length == 0:
            return ""
        return ctypes.wstring_at(value.Buffer, value.Length // ctypes.sizeof(ctypes.c_wchar))
    finally:
        kernel32.CloseHandle(handle)


def tcp_listener_owners(port: int) -> list[int]:
    completed = subprocess.run(
        ["netstat", "-ano", "-p", "tcp"],
        check=False,
        capture_output=True,
        text=True,
        timeout=8,
        creationflags=CREATE_NO_WINDOW,
    )
    owners: set[int] = set()
    for raw in completed.stdout.splitlines():
        fields = raw.split()
        if len(fields) < 5 or fields[0].upper() != "TCP" or fields[3].upper() != "LISTENING":
            continue
        local = fields[1].rsplit(":", 1)
        if len(local) == 2 and local[1] == str(port):
            try:
                owners.add(int(fields[4]))
            except ValueError:
                continue
    return sorted(owners)


def text_tail(path: Path, limit: int = 8_192) -> str:
    try:
        return path.read_bytes()[-limit:].decode("utf-8", errors="replace")
    except OSError:
        return ""


def webview_runtime_versions(webview_data: Path) -> list[dict[str, str]]:
    versions = []
    for path in sorted(webview_data.rglob("Last Version")):
        try:
            versions.append(
                {"path": str(path.relative_to(webview_data)), "version": path.read_text().strip()}
            )
        except OSError:
            continue
    return versions


def webview_launch_snapshot(
    process: subprocess.Popen[Any],
    webview_data: Path,
    stdout_path: Path,
    stderr_path: Path,
    port: int | None = None,
) -> dict[str, Any]:
    tree = windows_process_tree(process.pid)
    processes = tree.get("processes") or []
    webviews = [
        entry for entry in processes if str(entry.get("name", "")).lower() == "msedgewebview2.exe"
    ]
    owner_pids = tcp_listener_owners(port) if port is not None else []
    descendant_pids = {int(entry["pid"]) for entry in processes}
    return {
        "prismPid": process.pid,
        "prismExitCode": process.poll(),
        "webViewRuntimeVersions": webview_runtime_versions(webview_data),
        "processTree": tree,
        "webViewProcessCount": len(webviews),
        "browserArgumentsObserved": any(
            "--remote-debugging-port=0" in str(entry.get("commandLine") or "")
            for entry in webviews
        ),
        "port": port,
        "portOwnerPids": owner_pids,
        "portOwnedByProcessTree": bool(owner_pids)
        and all(owner in descendant_pids for owner in owner_pids),
        "stdoutTail": text_tail(stdout_path),
        "stderrTail": text_tail(stderr_path),
    }


def launch(
    executable: Path,
    output_dir: Path,
    context: RunContext,
) -> tuple[subprocess.Popen[Any], CDP, int]:
    context.check_deadline("launch")
    launch_index = len(context.result["diagnostics"]["devTools"]) + 1
    devtools: dict[str, Any] = {
        "timestamp": timestamp(),
        "requestedPort": 0,
        "port": None,
        "url": None,
        "status": "waiting",
        "error": None,
        "tabs": [],
    }
    context.result["diagnostics"]["devTools"].append(devtools)
    context.log("DEVTOOLS PORT requested=auto via exclusive WebView2 profile")
    context.checkpoint()
    webview_data = (
        output_dir
        / "webview2-data"
        / f"launch-{launch_index}-{os.getpid()}-{time.time_ns()}"
    )
    webview_data.mkdir(parents=True, exist_ok=True)
    removed_proxy_variables = []
    for name in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        if os.environ.pop(name, None) is not None:
            removed_proxy_variables.append(name)
    os.environ["NO_PROXY"] = "127.0.0.1,localhost"
    os.environ["no_proxy"] = "127.0.0.1,localhost"
    env = os.environ.copy()
    recorded = context.result["diagnostics"]["networkSafety"].setdefault(
        "removedProxyVariables", []
    )
    recorded.extend(name for name in removed_proxy_variables if name not in recorded)
    # Prove the compile-time Tauri builder path is responsible for CDP. Standard
    # WebView2 environment overrides must not make an ordinary build testable.
    env.pop("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", None)
    env.pop("WEBVIEW2_USER_DATA_FOLDER", None)
    env["TACHYON_PRISM_NATIVE_E2E_WEBVIEW_DATA_DIRECTORY"] = str(webview_data)
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
    deadline = time.monotonic() + 45
    last_error: Exception | None = None
    tabs: list[dict[str, Any]] = []
    debug_port: int | None = None
    active_port_path: Path | None = None
    browser_arguments_verified = False
    while time.monotonic() < deadline:
        context.check_deadline("DevTools discovery")
        if process.poll() is not None:
            error = f"Prism exited before DevTools was ready: exit code {process.returncode}"
            devtools.update(
                status="failed",
                error=error,
                launch=webview_launch_snapshot(
                    process, webview_data, stdout_path, stderr_path, debug_port
                ),
                finishedAt=timestamp(),
            )
            context.checkpoint()
            raise RuntimeError(error)
        if not browser_arguments_verified:
            launch_snapshot = webview_launch_snapshot(
                process, webview_data, stdout_path, stderr_path, None
            )
            if launch_snapshot["webViewProcessCount"] < 1:
                last_error = RuntimeError("WebView2 child process not observable yet")
                time.sleep(0.1)
                continue
            if not launch_snapshot["browserArgumentsObserved"]:
                error = "WebView2 child command line omitted remote-debugging-port=0"
                devtools.update(
                    status="failed",
                    error=error,
                    launch=launch_snapshot,
                    finishedAt=timestamp(),
                )
                context.log(
                    "DEVTOOLS ARGUMENT FAIL processTree="
                    + json.dumps(launch_snapshot["processTree"], ensure_ascii=False)
                )
                context.checkpoint()
                stop_process(process, context, "WebView2 remote-debugging argument missing")
                raise RuntimeError(error)
            browser_arguments_verified = True
            context.log(
                "DEVTOOLS ARGUMENT VERIFIED processTree="
                + json.dumps(launch_snapshot["processTree"], ensure_ascii=False)
            )
            context.checkpoint()
        candidates = sorted(webview_data.rglob("DevToolsActivePort"))
        if not candidates:
            last_error = RuntimeError("WebView2 DevToolsActivePort not published yet")
        for candidate in candidates:
            try:
                candidate_port, browser_path = parse_devtools_active_port(candidate)
                version = read_json(f"http://127.0.0.1:{candidate_port}/json/version", timeout=1.0)
                browser_url = str(version.get("webSocketDebuggerUrl", ""))
                if not browser_url.endswith(browser_path):
                    raise RuntimeError("WebView2 browser endpoint did not match its ready file")
                candidate_tabs = read_json(
                    f"http://127.0.0.1:{candidate_port}/json/list", timeout=1.0
                )
                snapshot = webview_launch_snapshot(
                    process, webview_data, stdout_path, stderr_path, candidate_port
                )
                owner_pids = snapshot["portOwnerPids"]
                process_by_pid = {
                    int(item["pid"]): str(item.get("name", "")).lower()
                    for item in snapshot["processTree"].get("processes", [])
                }
                if not owner_pids or not snapshot["portOwnedByProcessTree"]:
                    raise RuntimeError(
                        f"DevTools port {candidate_port} is not owned by the Prism process tree: {owner_pids}"
                    )
                if not all(process_by_pid.get(pid) == "msedgewebview2.exe" for pid in owner_pids):
                    raise RuntimeError(
                        f"DevTools port {candidate_port} owner is not WebView2: {owner_pids}"
                    )
                if not snapshot["webViewRuntimeVersions"] or snapshot["webViewProcessCount"] < 1:
                    raise RuntimeError("WebView2 runtime did not become observable")
                if not snapshot["browserArgumentsObserved"]:
                    raise RuntimeError("WebView2 command line omitted remote-debugging-port=0")
                if candidate_tabs:
                    debug_port = candidate_port
                    active_port_path = candidate
                    tabs = candidate_tabs
                    devtools["version"] = {
                        "browser": version.get("Browser"),
                        "protocolVersion": version.get("Protocol-Version"),
                    }
                    devtools["launch"] = snapshot
                    break
            except Exception as error:  # noqa: BLE001 - bounded readiness loop.
                last_error = error
        if tabs:
            break
        time.sleep(0.2)
    if not tabs:
        launch_snapshot = webview_launch_snapshot(
            process, webview_data, stdout_path, stderr_path, debug_port
        )
        error = (
            "Prism WebView2 remote debugging unavailable after 45s: "
            f"{last_error}; exeAlive={process.poll() is None}; "
            f"webViewProcesses={launch_snapshot['webViewProcessCount']}; "
            f"runtimeVersions={launch_snapshot['webViewRuntimeVersions']}"
        )
        devtools.update(
            status="failed", error=error, launch=launch_snapshot, finishedAt=timestamp()
        )
        context.log(f"DEVTOOLS FAIL: {error}")
        context.checkpoint()
        stop_process(process, context, "DevTools unavailable")
        raise RuntimeError(error)
    devtools_url = f"http://127.0.0.1:{debug_port}/json/list"
    devtools.update(
        status="ready",
        port=debug_port,
        url=devtools_url,
        activePortPath=str(active_port_path.relative_to(webview_data)),
        tabs=tabs,
        finishedAt=timestamp(),
    )
    context.log(
        f"DEVTOOLS READY port={debug_port} owner={devtools['launch']['portOwnerPids']} tabs={len(tabs)}"
    )
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


def tcp_listener_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.25):
            return True
    except OSError:
        return False


def xray_access_lines(path: Path) -> list[str]:
    try:
        return [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    except FileNotFoundError:
        return []


def request_fixture_direct(port: int) -> None:
    with socket.create_connection(("127.0.0.1", port), timeout=2) as connection:
        connection.sendall(
            b"GET /generate_204 HTTP/1.1\r\nHost: fixture.invalid\r\nConnection: close\r\n\r\n"
        )
        response = b""
        while b"\r\n" not in response:
            chunk = connection.recv(4096)
            if not chunk:
                break
            response += chunk
    assert_true(
        response.startswith(b"HTTP/1.0 204") or response.startswith(b"HTTP/1.1 204"),
        f"fixture direct control was not reachable: {response[:120]!r}",
    )


def start_xray_socks_upstream(
    xray: Path,
    port: int,
    target_port: int,
    output_dir: Path,
    context: RunContext,
) -> tuple[subprocess.Popen[Any], Path]:
    config_path = output_dir / "xray-selected-node-upstream.json"
    access_log = output_dir / "xray-selected-node.access.log"
    access_log.unlink(missing_ok=True)
    config_path.write_text(
        json.dumps(
            {
                "log": {"access": str(access_log), "loglevel": "warning"},
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
    return process, access_log


def run_ui_node_verification(cdp: CDP, context: RunContext, label: str) -> dict[str, Any]:
    before = str(
        cdp.evaluate("document.querySelector('.proxy-probe-panel')?.textContent ?? ''")
    )
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
    assert_true(click.get("clicked"), f"{label} did not start: {click}")

    deadline = time.monotonic() + 35
    state = None
    while time.monotonic() < deadline:
        context.check_deadline(label)
        state = cdp.evaluate(
            """
            (() => ({
              buttonDisabled: Boolean(document.querySelector('.proxy-probe-panel header button')?.disabled),
              panelClass: document.querySelector('.proxy-probe-panel')?.className ?? '',
              text: document.querySelector('.proxy-probe-panel')?.textContent ?? '',
              rows: Array.from(document.querySelectorAll('.proxy-probe-row')).map((row) => ({
                className: row.className,
                text: row.textContent ?? ''
              }))
            }))()
            """
        )
        terminal = " ok" in state["panelClass"] or " error" in state["panelClass"]
        if terminal and not state["buttonDisabled"] and state["text"] != before:
            return state
        time.sleep(0.2)
    raise AssertionError(f"{label} did not reach a new terminal UI state: {state}")


def verification_temp_residue(config_dir: Path, canonical_path: Path) -> list[str]:
    generation_dir = config_dir / "xray-generations"
    residue = [str(path) for path in generation_dir.glob("generation-*.json")]
    for name in ("orphan-journal.json", "orphan-recovery-failed.json"):
        path = generation_dir / name
        if path.exists():
            residue.append(str(path))
    residue.extend(
        str(path)
        for path in canonical_path.parent.glob(f".{canonical_path.stem}.*.tmp{canonical_path.suffix}")
    )
    return sorted(residue)


PROXY_AUDIT_FIELDS = ("captureCount", "restoreCount", "bindCount", "mutationCount")


def system_proxy_audit_delta(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    counts = {
        field.removesuffix("Count"): int(after.get(field, 0)) - int(before.get(field, 0))
        for field in PROXY_AUDIT_FIELDS
    }
    baseline_sequence = max(
        (int(event.get("sequence", 0)) for event in before.get("events") or []), default=0
    )
    events = [
        event
        for event in after.get("events") or []
        if int(event.get("sequence", 0)) > baseline_sequence
    ]
    return {**counts, "events": events}


def assert_no_system_proxy_calls(
    before: dict[str, Any], after: dict[str, Any], label: str
) -> dict[str, Any]:
    delta = system_proxy_audit_delta(before, after)
    assert_true(
        all(delta[name] == 0 for name in ("capture", "restore", "bind", "mutation"))
        and not delta["events"],
        f"{label} crossed a Rust system-proxy boundary: {delta}",
    )
    return delta


def assert_system_proxy_audit_zero(snapshot: dict[str, Any], label: str) -> None:
    assert_true(
        all(int(snapshot.get(field, 0)) == 0 for field in PROXY_AUDIT_FIELDS)
        and not snapshot.get("events"),
        f"{label} observed prior Rust system-proxy boundary calls: {snapshot}",
    )


def assert_result_proxy_audit_passable(result: dict[str, Any]) -> None:
    safety = result["diagnostics"]["networkSafety"]
    audit = safety.get("systemProxyAudit") or {}
    assert_true(audit.get("status") == "captured", "system proxy audit was not captured")
    assert_true(
        safety.get("proxyCommandsInvoked") is False,
        f"proxyCommandsInvoked was not false: {safety.get('proxyCommandsInvoked')!r}",
    )
    for snapshot_name in ("baseline", "afterNegativeControl", "afterRetrySuccess"):
        snapshot = audit.get(snapshot_name) or {}
        assert_system_proxy_audit_zero(snapshot, f"RESULT {snapshot_name}")
    for phase_name in ("negativeControlDelta", "retrySuccessDelta", "totalDelta"):
        phase = audit.get(phase_name) or {}
        assert_true(
            all(int(phase.get(field, 0)) == 0 for field in ("capture", "restore", "bind", "mutation"))
            and not phase.get("events"),
            f"RESULT {phase_name} crossed a Rust system-proxy boundary: {phase}",
        )


def assert_isolated_verification_recovered(
    cdp: CDP,
    context: RunContext,
    *,
    canonical_path: Path,
    config_dir: Path,
    listener_ports: tuple[int, int],
    proxy_before: dict[str, Any],
    audit_before: dict[str, Any],
    label: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    generation = invoke(cdp, context, "xray_generation_status")
    runtime = invoke(cdp, context, "runtime_status")
    proxy_after = system_proxy_mutation_snapshot(invoke(cdp, context, "system_proxy_query"))
    audit_after = invoke(cdp, context, "system_proxy_audit")
    audit_delta = assert_no_system_proxy_calls(audit_before, audit_after, label)
    residue = verification_temp_residue(config_dir, canonical_path)
    open_ports = [port for port in listener_ports if tcp_listener_open(port)]
    assert_true(
        generation.get("desired") is None
        and generation.get("active") is None
        and generation.get("proxyGeneration") is None
        and generation.get("phase") == "idle"
        and generation.get("proxyReady") is False
        and generation.get("lastErrorCode") is None,
        f"{label} left generation state: {generation}",
    )
    assert_true(
        runtime["xray"]["state"] == "stopped" and runtime["xray"].get("pid") is None,
        f"{label} left the product Xray process active: {runtime['xray']}",
    )
    assert_true(not open_ports, f"{label} left product listeners open: {open_ports}")
    assert_true(not residue, f"{label} left verification temp files: {residue}")
    assert_true(
        proxy_after == proxy_before,
        f"{label} mutated system proxy: before={proxy_before}, after={proxy_after}",
    )
    return {
        "generationIdle": True,
        "processStopped": True,
        "portsClosed": True,
        "systemProxyUnchanged": True,
        "systemProxyAudit": audit_delta,
        "tempClean": True,
    }, audit_after


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
    xray: Path,
    upstream_port: int,
    fixture_port: int,
    output_dir: Path,
    config_dir: Path,
    canonical_path: Path,
    listener_ports: tuple[int, int],
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
    audit_before = invoke(cdp, context, "system_proxy_audit")
    assert_system_proxy_audit_zero(audit_before, "isolated verification baseline")
    assert_true(
        not tcp_listener_open(upstream_port),
        f"negative-control selected upstream unexpectedly reachable: 127.0.0.1:{upstream_port}",
    )
    request_fixture_direct(fixture_port)
    fixture_before_failure = QuietHandler.request_count("/generate_204")
    failed_state = run_ui_node_verification(cdp, context, "negative-control node verification")
    assert_true(
        " error" in failed_state["panelClass"] and " ok" not in failed_state["panelClass"],
        f"unreachable selected upstream did not fail verification: {failed_state}",
    )
    fixture_after_failure = QuietHandler.request_count("/generate_204")
    assert_true(
        fixture_after_failure == fixture_before_failure,
        "negative verification reached the directly available fixture without its selected upstream",
    )
    failed_recovery, audit_after_failure = assert_isolated_verification_recovered(
        cdp,
        context,
        canonical_path=canonical_path,
        config_dir=config_dir,
        listener_ports=listener_ports,
        proxy_before=proxy_before,
        audit_before=audit_before,
        label="failed isolated verification",
    )
    assert_system_proxy_audit_zero(audit_after_failure, "negative-control completion")

    upstream_process, access_log = start_xray_socks_upstream(
        xray, upstream_port, fixture_port, output_dir, context
    )
    ingress_before = len(xray_access_lines(access_log))
    fixture_before = QuietHandler.request_count("/generate_204")
    passed_state = run_ui_node_verification(cdp, context, "retry node verification")
    if " ok" not in passed_state["panelClass"]:
        diagnostic = {
            "ui": passed_state,
            "managedConfig": managed_config,
            "generation": invoke(cdp, context, "xray_generation_status"),
            "runtime": invoke(cdp, context, "runtime_status"),
            "logs": invoke(cdp, context, "runtime_process_logs", {"kind": "xray"}),
        }
        raise AssertionError(f"retry UI verification failed: {diagnostic}")
    assert_true(
        len(passed_state["rows"]) == 2
        and all(" ok" in row["className"] for row in passed_state["rows"]),
        f"HTTP/SOCKS rows were not both successful: {passed_state}",
    )
    fixture_after = QuietHandler.request_count("/generate_204")
    assert_true(
        fixture_after - fixture_before == 2,
        f"fixture delta was not exactly +2: before={fixture_before}, after={fixture_after}",
    )
    deadline = time.monotonic() + 4
    ingress_after = len(xray_access_lines(access_log))
    while ingress_after - ingress_before < 2 and time.monotonic() < deadline:
        time.sleep(0.1)
        ingress_after = len(xray_access_lines(access_log))
    assert_true(
        ingress_after - ingress_before == 2,
        f"selected Xray SOCKS ingress delta was not exactly +2: before={ingress_before}, after={ingress_after}",
    )
    passed_recovery, audit_after_success = assert_isolated_verification_recovered(
        cdp,
        context,
        canonical_path=canonical_path,
        config_dir=config_dir,
        listener_ports=listener_ports,
        proxy_before=proxy_before,
        audit_before=audit_after_failure,
        label="successful isolated verification",
    )
    assert_system_proxy_audit_zero(audit_after_success, "retry-success completion")
    new_access_lines = xray_access_lines(access_log)[ingress_before:ingress_after]
    ingress_digest = hashlib.sha256("\n".join(new_access_lines).encode("utf-8")).hexdigest()
    stop_process(upstream_process, context, "selected upstream evidence complete")
    assert_true(not tcp_listener_open(upstream_port), "selected upstream did not stop after evidence")
    return {
        "status": "passed",
        "nodeId": selected_node_id,
        "requestTokenBound": True,
        "routingMode": "direct",
        "selectedOutbound": "socks",
        "selectedNodePort": upstream_port,
        "http": True,
        "socks": True,
        "fixtureRequests": fixture_after - fixture_before,
        "negativeControl": {
            "directFixtureReachable": True,
            "selectedUpstreamReachable": False,
            "verificationFailed": True,
            "fixtureDelta": fixture_after_failure - fixture_before_failure,
            "recovery": failed_recovery,
        },
        "selectedUpstreamIngress": {
            "before": ingress_before,
            "after": ingress_after,
            "delta": ingress_after - ingress_before,
            "evidenceSha256": ingress_digest,
            "source": access_log.name,
        },
        "retrySucceeded": True,
        "successfulRecovery": passed_recovery,
        "systemProxyUnchanged": True,
        "systemProxyAudit": {
            "baseline": audit_before,
            "afterNegativeControl": audit_after_failure,
            "afterRetrySuccess": audit_after_success,
            "negativeControlDelta": failed_recovery["systemProxyAudit"],
            "retrySuccessDelta": passed_recovery["systemProxyAudit"],
            "totalDelta": assert_no_system_proxy_calls(
                audit_before, audit_after_success, "complete isolated verification"
            ),
        },
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
            expected_head = os.environ.get("GITHUB_SHA", "").strip()
            context.result["expectedHead"] = expected_head or None
            if expected_head:
                assert_true(
                    head == expected_head,
                    f"native E2E HEAD mismatch: result={head}, GITHUB_SHA={expected_head}",
                )
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
            context.result["ui"]["status"] = "running"
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
            context.result["ipc"]["status"] = "running"
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
            context.result["diagnostics"]["networkSafety"]["isolatedXrayVerificationInvoked"] = True
            context.result["ipc"]["isolatedNodeVerification"] = {"status": "running"}
            verification_e2e = verify_selected_local_xray_node(
                cdp,
                context,
                xray,
                selected_node_port,
                server_port,
                output_dir,
                Path(paths["configDir"]),
                canonical_path,
                (saved_settings["xraySocksPort"], saved_settings["xrayHttpPort"]),
            )
            proxy_audit = verification_e2e["systemProxyAudit"]
            context.result["diagnostics"]["networkSafety"]["systemProxyAudit"] = {
                "status": "captured",
                **proxy_audit,
            }
            context.result["diagnostics"]["networkSafety"]["proxyCommandsInvoked"] = any(
                int(proxy_audit["afterRetrySuccess"].get(field, 0)) != 0
                for field in PROXY_AUDIT_FIELDS
            ) or bool(proxy_audit["afterRetrySuccess"].get("events"))
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
            assert_result_proxy_audit_passable(context.result)
            context.result["ipc"]["status"] = "passed"
            context.result["ui"]["status"] = "passed"
            status = "passed"
    except BaseException as error:  # noqa: BLE001 - always persist failure diagnostics.
        failure = {
            "type": type(error).__name__,
            "message": str(error),
            "traceback": traceback.format_exc(),
        }
        context.log(f"WORKER FAIL {type(error).__name__}: {error}")
        for language, record in context.result["screenshots"].items():
            if record["status"] == "running":
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
            if record.get("status") == "running":
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
    failure_message = (result.get("failure") or {}).get("message", "worker did not finish")
    for record in result.get("diagnostics", {}).get("steps", []):
        if record.get("status") == "running":
            record.update(status="failed", finishedAt=timestamp(), error=failure_message)
    for section_name in ("ipc", "ui"):
        section = result.get(section_name)
        if isinstance(section, dict) and section.get("status") == "running":
            section["status"] = "failed"
    isolated = result.get("ipc", {}).get("isolatedNodeVerification")
    if isinstance(isolated, dict) and isolated.get("status") == "running":
        isolated["status"] = "failed"
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
