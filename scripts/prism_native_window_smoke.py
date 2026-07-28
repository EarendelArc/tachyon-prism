from __future__ import annotations

import argparse
import ctypes
import json
import os
import shutil
import subprocess
import time
from ctypes import wintypes
from pathlib import Path
from typing import Any, Callable

from prism_ui_smoke import CDP, free_port, wait_for_shell, wait_json


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EXE = ROOT / "src-tauri" / "target" / "release" / "tachyon-prism.exe"
DEFAULT_ARTIFACTS = ROOT / "artifacts" / "native-window-smoke"
CREATE_NO_WINDOW = 0x08000000
GWL_STYLE = -16
GWL_EXSTYLE = -20
WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
WS_EX_TOPMOST = 0x00000008
SW_RESTORE = 9
VK_MENU = 0x12
KEYEVENTF_KEYUP = 0x0002
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_VIRTUALDESK = 0x4000
MOUSEEVENTF_ABSOLUTE = 0x8000
SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79
DWMWA_EXTENDED_FRAME_BOUNDS = 9
LOGICAL_WIDTH = 800.0
LOGICAL_HEIGHT = 540.0
LOGICAL_TOLERANCE = 2.0
MAXIMUM_ALLOWED = 0x02000000


class InputGateBlocked(RuntimeError):
    pass


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class MSG(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("message", wintypes.UINT),
        ("wParam", wintypes.WPARAM),
        ("lParam", wintypes.LPARAM),
        ("time", wintypes.DWORD),
        ("pt", POINT),
        ("lPrivate", wintypes.DWORD),
    ]


ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("value",)
    _fields_ = [("type", wintypes.DWORD), ("value", INPUT_UNION)]


user32 = ctypes.WinDLL("user32", use_last_error=True)
user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
user32.SetProcessDpiAwarenessContext.restype = wintypes.BOOL
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [EnumWindowsProc, wintypes.LPARAM]
user32.EnumWindows.restype = wintypes.BOOL
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsWindowVisible.restype = wintypes.BOOL
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
user32.GetWindowRect.restype = wintypes.BOOL
user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
user32.GetClientRect.restype = wintypes.BOOL
user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(POINT)]
user32.ClientToScreen.restype = wintypes.BOOL
user32.GetDpiForWindow.argtypes = [wintypes.HWND]
user32.GetDpiForWindow.restype = wintypes.UINT
user32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.restype = ctypes.c_int
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
user32.SetCursorPos.restype = wintypes.BOOL
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.SetForegroundWindow.restype = wintypes.BOOL
user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
user32.AttachThreadInput.restype = wintypes.BOOL
user32.BringWindowToTop.argtypes = [wintypes.HWND]
user32.BringWindowToTop.restype = wintypes.BOOL
user32.SetActiveWindow.argtypes = [wintypes.HWND]
user32.SetActiveWindow.restype = wintypes.HWND
user32.SetFocus.argtypes = [wintypes.HWND]
user32.SetFocus.restype = wintypes.HWND
user32.PeekMessageW.argtypes = [
    ctypes.POINTER(MSG),
    wintypes.HWND,
    wintypes.UINT,
    wintypes.UINT,
    wintypes.UINT,
]
user32.PeekMessageW.restype = wintypes.BOOL
user32.SwitchToThisWindow.argtypes = [wintypes.HWND, wintypes.BOOL]
user32.SwitchToThisWindow.restype = None
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.ShowWindow.restype = wintypes.BOOL
user32.IsIconic.argtypes = [wintypes.HWND]
user32.IsIconic.restype = wintypes.BOOL
user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
user32.SendInput.restype = wintypes.UINT
user32.GetForegroundWindow.argtypes = []
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetSystemMetrics.argtypes = [ctypes.c_int]
user32.GetSystemMetrics.restype = ctypes.c_int
user32.OpenWindowStationW.argtypes = [wintypes.LPCWSTR, wintypes.BOOL, wintypes.DWORD]
user32.OpenWindowStationW.restype = wintypes.HANDLE
user32.SetProcessWindowStation.argtypes = [wintypes.HANDLE]
user32.SetProcessWindowStation.restype = wintypes.BOOL
user32.OpenDesktopW.argtypes = [
    wintypes.LPCWSTR,
    wintypes.DWORD,
    wintypes.BOOL,
    wintypes.DWORD,
]
user32.OpenDesktopW.restype = wintypes.HANDLE
user32.SetThreadDesktop.argtypes = [wintypes.HANDLE]
user32.SetThreadDesktop.restype = wintypes.BOOL
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.GetCurrentThreadId.argtypes = []
kernel32.GetCurrentThreadId.restype = wintypes.DWORD
dwmapi = ctypes.WinDLL("dwmapi", use_last_error=True)
dwmapi.DwmGetWindowAttribute.argtypes = [
    wintypes.HWND,
    wintypes.DWORD,
    ctypes.c_void_p,
    wintypes.DWORD,
]
dwmapi.DwmGetWindowAttribute.restype = ctypes.c_long


def attach_to_interactive_desktop() -> dict[str, Any]:
    result: dict[str, Any] = {
        "windowStation": "WinSta0",
        "desktop": "Default",
        "processWindowStationAttached": False,
        "threadDesktopAttached": False,
    }
    station = user32.OpenWindowStationW("WinSta0", False, MAXIMUM_ALLOWED)
    if not station:
        result["error"] = f"OpenWindowStationW: {ctypes.WinError(ctypes.get_last_error())}"
        return result
    result["stationHandle"] = int(station)
    if not user32.SetProcessWindowStation(station):
        result["error"] = f"SetProcessWindowStation: {ctypes.WinError(ctypes.get_last_error())}"
        return result
    result["processWindowStationAttached"] = True
    desktop = user32.OpenDesktopW("Default", 0, False, MAXIMUM_ALLOWED)
    if not desktop:
        result["error"] = f"OpenDesktopW: {ctypes.WinError(ctypes.get_last_error())}"
        return result
    result["desktopHandle"] = int(desktop)
    if not user32.SetThreadDesktop(desktop):
        result["error"] = f"SetThreadDesktop: {ctypes.WinError(ctypes.get_last_error())}"
        return result
    result["threadDesktopAttached"] = True
    return result


# Keep Win32 geometry in physical pixels so DPI normalization is applied exactly once.
if not user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
    error = ctypes.get_last_error()
    if error != 5:  # ERROR_ACCESS_DENIED means the host already selected a DPI context.
        raise ctypes.WinError(error, "SetProcessDpiAwarenessContext")


def win32_check(value: Any, operation: str) -> None:
    if not value:
        raise ctypes.WinError(ctypes.get_last_error(), operation)


def wait_until(predicate: Callable[[], bool], description: str, timeout: float = 4.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {description}")


def window_rect(hwnd: int) -> dict[str, int]:
    rect = RECT()
    win32_check(user32.GetWindowRect(hwnd, ctypes.byref(rect)), "GetWindowRect")
    return {
        "left": rect.left,
        "top": rect.top,
        "right": rect.right,
        "bottom": rect.bottom,
        "width": rect.right - rect.left,
        "height": rect.bottom - rect.top,
    }


def client_geometry(hwnd: int) -> dict[str, int]:
    rect = RECT()
    origin = POINT(0, 0)
    win32_check(user32.GetClientRect(hwnd, ctypes.byref(rect)), "GetClientRect")
    win32_check(user32.ClientToScreen(hwnd, ctypes.byref(origin)), "ClientToScreen")
    return {
        "left": origin.x,
        "top": origin.y,
        "width": rect.right - rect.left,
        "height": rect.bottom - rect.top,
    }


def logical_size(width: int, height: int, dpi: int) -> dict[str, float]:
    return {
        "width": round(width * 96.0 / dpi, 4),
        "height": round(height * 96.0 / dpi, 4),
    }


def extended_frame_rect(hwnd: int) -> dict[str, int] | None:
    rect = RECT()
    result = dwmapi.DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        ctypes.byref(rect),
        ctypes.sizeof(rect),
    )
    if result != 0:
        return None
    return {
        "left": rect.left,
        "top": rect.top,
        "right": rect.right,
        "bottom": rect.bottom,
        "width": rect.right - rect.left,
        "height": rect.bottom - rect.top,
    }


def assert_logical_dimension(actual: float, expected: float, label: str) -> None:
    if abs(actual - expected) > LOGICAL_TOLERANCE:
        raise AssertionError(
            f"{label} is {actual:.4f}, expected {expected:.1f} +/- {LOGICAL_TOLERANCE:.2f} logical px"
        )


def measure_window(hwnd: int, cdp: CDP, label: str) -> dict[str, Any]:
    dpi = int(user32.GetDpiForWindow(hwnd)) or 96
    outer = window_rect(hwnd)
    client = client_geometry(hwnd)
    extended_frame = extended_frame_rect(hwnd)
    viewport = cdp.evaluate(
        "({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, hash: location.hash })"
    )
    measurement = {
        "label": label,
        "dpi": dpi,
        "outerPhysical": outer,
        "outerLogical": logical_size(outer["width"], outer["height"], dpi),
        "dwmExtendedFramePhysical": extended_frame,
        "dwmExtendedFrameLogical": (
            logical_size(extended_frame["width"], extended_frame["height"], dpi)
            if extended_frame is not None
            else None
        ),
        "clientPhysical": client,
        "clientLogical": logical_size(client["width"], client["height"], dpi),
        "outerClientBorderLogical": {
            "width": round((outer["width"] - client["width"]) * 96.0 / dpi, 4),
            "height": round((outer["height"] - client["height"]) * 96.0 / dpi, 4),
        },
        "viewport": viewport,
    }
    assert_logical_dimension(
        measurement["clientLogical"]["width"], LOGICAL_WIDTH, f"{label} client width"
    )
    assert_logical_dimension(
        measurement["clientLogical"]["height"], LOGICAL_HEIGHT, f"{label} client height"
    )
    assert_logical_dimension(float(viewport["width"]), LOGICAL_WIDTH, f"{label} WebView width")
    assert_logical_dimension(float(viewport["height"]), LOGICAL_HEIGHT, f"{label} WebView height")
    expected_dpr = dpi / 96.0
    if abs(float(viewport["dpr"]) - expected_dpr) > 0.02:
        raise AssertionError(
            f"{label} WebView DPR {viewport['dpr']} does not match window DPI scale {expected_dpr:.4f}"
        )
    return measurement


def assert_measurement_stable(baseline: dict[str, Any], current: dict[str, Any]) -> None:
    for kind in ("outerLogical", "clientLogical"):
        for dimension in ("width", "height"):
            delta = abs(float(current[kind][dimension]) - float(baseline[kind][dimension]))
            if delta > LOGICAL_TOLERANCE:
                raise AssertionError(
                    f"{current['label']} changed {kind} {dimension} by {delta:.4f} logical px"
                )
    for coordinate in ("left", "top"):
        delta = abs(
            int(current["outerPhysical"][coordinate])
            - int(baseline["outerPhysical"][coordinate])
        )
        if delta > 2:
            raise AssertionError(
                f"{current['label']} moved outer {coordinate} by {delta} physical px during page switch"
            )


def visible_process_windows(pid: int) -> list[dict[str, Any]]:
    windows: list[dict[str, Any]] = []

    @EnumWindowsProc
    def collect(hwnd: int, _: int) -> bool:
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            class_name = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, class_name, len(class_name))
            windows.append(
                {
                    "handle": int(hwnd),
                    "className": class_name.value,
                    "rect": window_rect(int(hwnd)),
                }
            )
        return True

    user32.EnumWindows(collect, 0)
    return windows


def find_main_window(pid: int, timeout: float = 20.0) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        candidates = visible_process_windows(pid)
        for candidate in candidates:
            rect = candidate["rect"]
            if rect["width"] >= 600 and rect["height"] >= 400:
                return int(candidate["handle"])
        time.sleep(0.1)
    raise AssertionError("Prism main window did not appear")


def mouse_input(flags: int, dx: int = 0, dy: int = 0) -> INPUT:
    return INPUT(type=0, mi=MOUSEINPUT(dx, dy, 0, flags, 0, 0))


def send_mouse(flags: int) -> None:
    event = mouse_input(flags)
    sent = user32.SendInput(1, ctypes.byref(event), ctypes.sizeof(INPUT))
    if sent != 1:
        raise ctypes.WinError(ctypes.get_last_error(), f"SendInput({flags:#x})")


def send_alt_pulse() -> None:
    events = (INPUT * 2)(
        INPUT(type=1, ki=KEYBDINPUT(VK_MENU, 0, 0, 0, 0)),
        INPUT(type=1, ki=KEYBDINPUT(VK_MENU, 0, KEYEVENTF_KEYUP, 0, 0)),
    )
    sent = user32.SendInput(2, events, ctypes.sizeof(INPUT))
    if sent != 2:
        raise ctypes.WinError(ctypes.get_last_error(), "SendInput(Alt pulse)")


def attached_activation_attempt(hwnd: int) -> dict[str, Any]:
    message = MSG()
    user32.PeekMessageW(ctypes.byref(message), None, 0, 0, 0)
    current_thread = int(kernel32.GetCurrentThreadId())
    target_thread = int(user32.GetWindowThreadProcessId(hwnd, None))
    foreground_before = int(user32.GetForegroundWindow() or 0)
    foreground_thread = (
        int(user32.GetWindowThreadProcessId(foreground_before, None))
        if foreground_before
        else 0
    )
    attached: list[int] = []
    attach_results: dict[str, bool] = {}
    try:
        for label, thread_id in (("target", target_thread), ("foreground", foreground_thread)):
            if not thread_id or thread_id == current_thread or thread_id in attached:
                continue
            ok = bool(user32.AttachThreadInput(current_thread, thread_id, True))
            attach_results[label] = ok
            if ok:
                attached.append(thread_id)
        brought_to_top = bool(user32.BringWindowToTop(hwnd))
        user32.SetActiveWindow(hwnd)
        user32.SetFocus(hwnd)
        set_foreground = bool(user32.SetForegroundWindow(hwnd))
        time.sleep(0.12)
        foreground_after = int(user32.GetForegroundWindow() or 0)
        return {
            "currentThread": current_thread,
            "targetThread": target_thread,
            "foregroundThreadBefore": foreground_thread,
            "foregroundBefore": foreground_before,
            "attachResults": attach_results,
            "bringWindowToTop": brought_to_top,
            "setForegroundWindow": set_foreground,
            "foregroundAfter": foreground_after,
            "confirmed": foreground_after == hwnd,
        }
    finally:
        for thread_id in reversed(attached):
            user32.AttachThreadInput(current_thread, thread_id, False)


def activate_window(hwnd: int) -> dict[str, Any]:
    user32.ShowWindow(hwnd, SW_RESTORE)
    wait_until(lambda: not bool(user32.IsIconic(hwnd)), "Prism restore before activation")
    attempts = [attached_activation_attempt(hwnd)]
    if not attempts[-1]["confirmed"]:
        user32.SwitchToThisWindow(hwnd, True)
        time.sleep(0.2)
        attempts.append(
            {
                "fallback": "SwitchToThisWindow",
                "foregroundAfter": int(user32.GetForegroundWindow() or 0),
                "confirmed": int(user32.GetForegroundWindow() or 0) == hwnd,
            }
        )
    alt_pulse_error: str | None = None
    if not attempts[-1]["confirmed"]:
        try:
            send_alt_pulse()
        except OSError as error:
            alt_pulse_error = str(error)
        attempts.append(attached_activation_attempt(hwnd))
    foreground = int(user32.GetForegroundWindow() or 0)
    if foreground != hwnd:
        raise InputGateBlocked(
            f"Prism foreground activation denied: hwnd={hwnd}, foreground={foreground}, "
            f"attempts={attempts}, altPulseError={alt_pulse_error}"
        )
    fallback_names = [attempt.get("fallback") for attempt in attempts if attempt.get("fallback")]
    return {
        "method": "+".join(fallback_names + ["thread-input-attach"]),
        "foregroundConfirmed": True,
        "foreground": foreground,
        "altPulseError": alt_pulse_error,
        "attempts": attempts,
    }


def send_absolute_move(x: int, y: int) -> None:
    left = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
    top = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    width = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
    height = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
    if width <= 1 or height <= 1:
        raise AssertionError(f"invalid virtual screen bounds: {(left, top, width, height)}")
    normalized_x = round((x - left) * 65535 / (width - 1))
    normalized_y = round((y - top) * 65535 / (height - 1))
    event = mouse_input(
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        max(0, min(65535, normalized_x)),
        max(0, min(65535, normalized_y)),
    )
    sent = user32.SendInput(1, ctypes.byref(event), ctypes.sizeof(INPUT))
    if sent != 1:
        raise ctypes.WinError(ctypes.get_last_error(), "SendInput(absolute move)")


def css_point_to_screen(hwnd: int, cdp: CDP, point: dict[str, float]) -> tuple[int, int]:
    client = client_geometry(hwnd)
    dpr = float(cdp.evaluate("devicePixelRatio"))
    return (
        client["left"] + round(float(point["x"]) * dpr),
        client["top"] + round(float(point["y"]) * dpr),
    )


def drag_point(cdp: CDP) -> dict[str, float]:
    point = cdp.evaluate(
        """
        (() => {
          const header = document.querySelector('.app-titlebar');
          const left = document.querySelector('.title-left');
          const actions = document.querySelector('.window-actions');
          if (!header || !left || !actions) throw new Error('custom titlebar geometry missing');
          const h = header.getBoundingClientRect();
          const l = left.getBoundingClientRect();
          const a = actions.getBoundingClientRect();
          const x = (l.right + a.left) / 2;
          const y = (h.top + h.bottom) / 2;
          const target = document.elementFromPoint(x, y);
          return {
            x,
            y,
            gap: a.left - l.right,
            blocked: Boolean(target?.closest('button, input, select, textarea, a, [data-no-window-drag]')),
            insideHeader: Boolean(target?.closest('.app-titlebar'))
          };
        })()
        """
    )
    if point["gap"] < 24 or point["blocked"] or not point["insideHeader"]:
        raise AssertionError(f"titlebar has no safe blank drag point: {point}")
    return point


def action_point(cdp: CDP, action: str) -> dict[str, float]:
    point = cdp.evaluate(
        f"""
        (() => {{
          const button = document.querySelector('[data-window-action={json.dumps(action)}]');
          if (!button) throw new Error('window action missing: ' + {json.dumps(action)});
          const rect = button.getBoundingClientRect();
          const x = (rect.left + rect.right) / 2;
          const y = (rect.top + rect.bottom) / 2;
          return {{
            x,
            y,
            disabled: button.disabled,
            hitAction: document.elementFromPoint(x, y)?.closest('[data-window-action]')?.dataset.windowAction ?? ''
          }};
        }})()
        """
    )
    if point["hitAction"] != action:
        raise AssertionError(f"window action hit target mismatch for {action}: {point}")
    return point


def titlebar_contract(cdp: CDP) -> dict[str, Any]:
    contract = cdp.evaluate(
        """
        (() => {
          const header = document.querySelector('.app-titlebar');
          const left = document.querySelector('.title-left');
          const fill = document.querySelector('.title-drag-fill');
          const actions = document.querySelector('.window-actions');
          const buttons = Object.fromEntries(
            Array.from(document.querySelectorAll('[data-window-action]')).map((button) => [
              button.dataset.windowAction,
              {
                disabled: button.disabled,
                ariaLabel: button.getAttribute('aria-label') ?? '',
                ariaPressed: button.getAttribute('aria-pressed')
              }
            ])
          );
          return {
            headerDrag: header?.hasAttribute('data-tauri-drag-region') ?? false,
            leftDrag: left?.hasAttribute('data-tauri-drag-region') ?? false,
            fillDrag: fill?.hasAttribute('data-tauri-drag-region') ?? false,
            actionsNoDrag: actions?.hasAttribute('data-no-window-drag') ?? false,
            buttons
          };
        })()
        """
    )
    expected_actions = {"pin", "minimize", "maximize", "close"}
    buttons = contract.get("buttons", {})
    if set(buttons) != expected_actions:
        raise AssertionError(f"unexpected titlebar controls: {contract}")
    if not all(
        contract.get(marker)
        for marker in ("headerDrag", "leftDrag", "fillDrag", "actionsNoDrag")
    ):
        raise AssertionError(f"titlebar drag/no-drag markers are incomplete: {contract}")
    for action, state in buttons.items():
        if not state.get("ariaLabel"):
            raise AssertionError(f"titlebar action has no accessible label: {action}")
    if not buttons["maximize"].get("disabled"):
        raise AssertionError("fixed-size maximize control is not disabled")
    for action in ("pin", "minimize", "close"):
        if buttons[action].get("disabled"):
            raise AssertionError(f"titlebar action is unexpectedly disabled: {action}")
        action_point(cdp, action)
    action_point(cdp, "maximize")
    return contract


def click_action(cdp: CDP, action: str) -> None:
    cdp.evaluate(
        f"""
        (() => {{
          const button = document.querySelector('[data-window-action={json.dumps(action)}]');
          if (!button) throw new Error('window action missing: ' + {json.dumps(action)});
          button.click();
        }})()
        """
    )


def assert_window_stationary(before: dict[str, int], after: dict[str, int], action: str) -> None:
    if abs(after["left"] - before["left"]) > 1 or abs(after["top"] - before["top"]) > 1:
        raise AssertionError(f"{action} button incorrectly dragged the window: before={before}, after={after}")


def real_drag(
    hwnd: int, cdp: CDP
) -> tuple[dict[str, int], dict[str, int], dict[str, Any]]:
    before = window_rect(hwnd)
    start_x, start_y = css_point_to_screen(hwnd, cdp, drag_point(cdp))
    activation = activate_window(hwnd)
    if int(user32.GetForegroundWindow() or 0) != hwnd:
        raise AssertionError("Prism lost foreground immediately before SendInput drag")
    send_absolute_move(start_x, start_y)
    time.sleep(0.1)
    send_mouse(MOUSEEVENTF_LEFTDOWN)
    try:
        for step in range(1, 13):
            send_absolute_move(start_x + 5 * step, start_y + 3 * step)
            time.sleep(0.025)
    finally:
        send_mouse(MOUSEEVENTF_LEFTUP)
    wait_until(
        lambda: abs(window_rect(hwnd)["left"] - before["left"]) >= 20
        or abs(window_rect(hwnd)["top"] - before["top"]) >= 15,
        "native titlebar drag",
    )
    return before, window_rect(hwnd), activation


def launch(executable: Path, artifacts: Path) -> tuple[subprocess.Popen[bytes], CDP, int]:
    debug_port = free_port()
    profile = artifacts / "webview2-data"
    isolated_appdata = artifacts / "appdata"
    shutil.rmtree(profile, ignore_errors=True)
    shutil.rmtree(isolated_appdata, ignore_errors=True)
    profile.mkdir(parents=True, exist_ok=True)
    (isolated_appdata / "Roaming").mkdir(parents=True, exist_ok=True)
    (isolated_appdata / "Local").mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["APPDATA"] = str(isolated_appdata / "Roaming")
    env["LOCALAPPDATA"] = str(isolated_appdata / "Local")
    env["WEBVIEW2_USER_DATA_FOLDER"] = str(profile)
    env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (
        f"--remote-debugging-address=127.0.0.1 --remote-debugging-port={debug_port} "
        "--remote-allow-origins=* --disable-background-networking"
    )
    process = subprocess.Popen(
        [str(executable)],
        cwd=executable.parent,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW,
    )
    try:
        tabs = wait_json(f"http://127.0.0.1:{debug_port}/json/list", timeout=25)
        page = next(item for item in tabs if item.get("type") == "page")
        cdp = CDP(page["webSocketDebuggerUrl"])
        cdp.call("Runtime.enable")
        cdp.call("Page.enable")
        wait_for_shell(cdp)
        return process, cdp, find_main_window(process.pid)
    except Exception:
        stop_process(process)
        raise


def stop_process(process: subprocess.Popen[Any]) -> None:
    if process.poll() is not None:
        return
    subprocess.run(
        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
        check=False,
        capture_output=True,
        creationflags=CREATE_NO_WINDOW,
        timeout=8,
    )
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def run_l1(executable: Path, artifacts: Path) -> dict[str, Any]:
    artifacts.mkdir(parents=True, exist_ok=True)
    process: subprocess.Popen[Any] | None = None
    cdp: CDP | None = None
    closed_by_control = False
    try:
        process, cdp, hwnd = launch(executable, artifacts)
        style = int(user32.GetWindowLongPtrW(hwnd, GWL_STYLE))
        if style & WS_CAPTION:
            raise AssertionError(f"native WS_CAPTION is present: style={style:#x}")
        if style & WS_THICKFRAME:
            raise AssertionError(f"native WS_THICKFRAME is present: style={style:#x}")
        windows = visible_process_windows(process.pid)
        consoles = [item for item in windows if item["className"] == "ConsoleWindowClass"]
        if consoles:
            raise AssertionError(f"visible console window found: {consoles}")

        controls = titlebar_contract(cdp)
        measurements = [measure_window(hwnd, cdp, "startup")]
        baseline = measurements[0]
        for view in ("overview", "configs", "subscriptions", "plugins", "settings"):
            cdp.evaluate(
                f"new Promise((resolve) => {{ location.hash = {json.dumps(view)}; setTimeout(resolve, 250); }})",
                await_promise=True,
            )
            current_hash = str(cdp.evaluate("location.hash"))
            if current_hash != f"#{view}":
                raise AssertionError(f"native page switch failed for {view}: {current_hash}")
            measurement = measure_window(hwnd, cdp, f"view:{view}")
            assert_measurement_stable(baseline, measurement)
            measurements.append(measurement)

        cdp.evaluate("location.hash = 'overview'")
        time.sleep(0.25)
        before = window_rect(hwnd)
        click_action(cdp, "maximize")
        time.sleep(0.25)
        assert_window_stationary(before, window_rect(hwnd), "disabled maximize")

        before = window_rect(hwnd)
        action_point(cdp, "pin")
        click_action(cdp, "pin")
        wait_until(
            lambda: bool(int(user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOPMOST),
            "pin control to enable topmost",
        )
        wait_until(
            lambda: cdp.evaluate(
                "document.querySelector('[data-window-action=pin]')?.getAttribute('aria-pressed')"
            )
            == "true",
            "pin aria-pressed=true",
        )
        assert_window_stationary(before, window_rect(hwnd), "pin")
        action_point(cdp, "pin")
        click_action(cdp, "pin")
        wait_until(
            lambda: not bool(int(user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOPMOST),
            "pin control to disable topmost",
        )
        wait_until(
            lambda: cdp.evaluate(
                "document.querySelector('[data-window-action=pin]')?.getAttribute('aria-pressed')"
            )
            == "false",
            "pin aria-pressed=false",
        )
        assert_window_stationary(before, window_rect(hwnd), "pin toggle")

        before_minimize = window_rect(hwnd)
        action_point(cdp, "minimize")
        click_action(cdp, "minimize")
        wait_until(lambda: bool(user32.IsIconic(hwnd)), "minimize control")
        user32.ShowWindow(hwnd, SW_RESTORE)
        wait_until(lambda: not bool(user32.IsIconic(hwnd)), "window restore")
        time.sleep(0.25)
        assert_window_stationary(before_minimize, window_rect(hwnd), "minimize/restore")
        measurements.append(measure_window(hwnd, cdp, "after-restore"))

        action_point(cdp, "close")
        click_action(cdp, "close")
        wait_until(lambda: process.poll() is not None, "close control", timeout=6.0)
        closed_by_control = True
        result = {
            "status": "passed",
            "level": "L1",
            "executable": str(executable),
            "pid": process.pid,
            "style": f"{style:#x}",
            "nativeCaptionAbsent": True,
            "nativeThickFrameAbsent": True,
            "visibleConsoleAbsent": True,
            "titlebarContract": controls,
            "titlebarDragInput": "not-run-at-L1",
            "pinControlWorks": True,
            "pinNativeTopmostEnabled": True,
            "pinNativeTopmostDisabled": True,
            "maximizeDisabledAndNonDraggable": True,
            "minimizeControlWorks": True,
            "minimizeNativeIconicObserved": True,
            "closeControlWorks": True,
            "logicalSizeTolerance": LOGICAL_TOLERANCE,
            "measurements": measurements,
        }
        (artifacts / "L1_RESULT.json").write_text(
            json.dumps(result, indent=2) + "\n", encoding="utf-8"
        )
        return result
    finally:
        if cdp is not None:
            cdp.close()
        if process is not None and not closed_by_control:
            stop_process(process)


def run_l2(executable: Path, artifacts: Path) -> dict[str, Any]:
    artifacts.mkdir(parents=True, exist_ok=True)
    process: subprocess.Popen[Any] | None = None
    cdp: CDP | None = None
    desktop_attachment = attach_to_interactive_desktop()
    try:
        process, cdp, hwnd = launch(executable, artifacts)
        titlebar_contract(cdp)
        try:
            drag_before, drag_after, drag_activation = real_drag(hwnd, cdp)
        except InputGateBlocked as error:
            result = {
                "status": "blocked",
                "level": "L2",
                "reasonCode": "foreground-or-uipi-denied",
                "reason": str(error),
                "desktopAttachment": desktop_attachment,
                "titlebarDragWorks": False,
            }
            (artifacts / "L2_RESULT.json").write_text(
                json.dumps(result, indent=2) + "\n", encoding="utf-8"
            )
            return result
        result = {
            "status": "passed",
            "level": "L2",
            "executable": str(executable),
            "pid": process.pid,
            "desktopAttachment": desktop_attachment,
            "titlebarDragWorks": True,
            "dragBefore": drag_before,
            "dragAfter": drag_after,
            "dragDelta": {
                "x": drag_after["left"] - drag_before["left"],
                "y": drag_after["top"] - drag_before["top"],
            },
            "dragActivation": drag_activation,
        }
        (artifacts / "L2_RESULT.json").write_text(
            json.dumps(result, indent=2) + "\n", encoding="utf-8"
        )
        return result
    finally:
        if cdp is not None:
            cdp.close()
        if process is not None:
            stop_process(process)


def run_strict(executable: Path, artifacts: Path) -> dict[str, Any]:
    l1 = run_l1(executable, artifacts / "l1")
    l2 = run_l2(executable, artifacts / "l2")
    result = {"status": l2["status"], "level": "strict", "l1": l1, "l2": l2}
    (artifacts / "STRICT_RESULT.json").write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8"
    )
    if l2["status"] != "passed":
        raise InputGateBlocked(
            f"strict native gate requires L2 real input: {l2['reasonCode']}: {l2['reason']}"
        )
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", default=str(DEFAULT_EXE))
    parser.add_argument("--out", default=str(DEFAULT_ARTIFACTS))
    parser.add_argument("--level", choices=("l1", "l2", "strict"), default="l1")
    args = parser.parse_args()
    executable = Path(args.executable).resolve()
    if not executable.is_file():
        raise SystemExit(f"Prism executable not found: {executable}")
    artifacts = Path(args.out).resolve()
    try:
        if args.level == "l1":
            result = run_l1(executable, artifacts)
        elif args.level == "l2":
            result = run_l2(executable, artifacts)
        else:
            result = run_strict(executable, artifacts)
    except BaseException as error:
        artifacts.mkdir(parents=True, exist_ok=True)
        (artifacts / f"{args.level.upper()}_ERROR.json").write_text(
            json.dumps(
                {
                    "status": "failed",
                    "level": args.level.upper(),
                    "errorType": type(error).__name__,
                    "error": str(error),
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        raise
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
