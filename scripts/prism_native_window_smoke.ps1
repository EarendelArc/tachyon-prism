param(
  [string]$Executable = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if ([string]::IsNullOrWhiteSpace($Executable)) {
  $Executable = Join-Path $repoRoot "src-tauri\target\release\tachyon-prism.exe"
}

$Executable = [System.IO.Path]::GetFullPath($Executable)
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "Prism executable not found: $Executable"
}

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class PrismNativeSmokeWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

  public static List<IntPtr> VisibleWindowsForProcess(uint targetPid) {
    List<IntPtr> windows = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pid == targetPid && IsWindowVisible(hWnd)) {
        windows.Add(hWnd);
      }
      return true;
    }, IntPtr.Zero);
    return windows;
  }

  public static string WindowTitle(IntPtr hWnd) {
    StringBuilder text = new StringBuilder(512);
    GetWindowText(hWnd, text, text.Capacity);
    return text.ToString();
  }

  public static string WindowClass(IntPtr hWnd) {
    StringBuilder text = new StringBuilder(512);
    GetClassName(hWnd, text, text.Capacity);
    return text.ToString();
  }
}
"@

function Get-RectObject {
  param([IntPtr]$Handle)
  $rect = New-Object PrismNativeSmokeWin32+RECT
  [PrismNativeSmokeWin32]::GetWindowRect($Handle, [ref]$rect) | Out-Null
  [pscustomobject]@{
    left = $rect.Left
    top = $rect.Top
    right = $rect.Right
    bottom = $rect.Bottom
    width = $rect.Right - $rect.Left
    height = $rect.Bottom - $rect.Top
  }
}

function Wait-ForMainWindow {
  param(
    [System.Diagnostics.Process]$Process,
    [int]$TimeoutSeconds = 20,
    [int]$StableChecks = 2
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $stableHandle = [IntPtr]::Zero
  $stableCount = 0
  while ((Get-Date) -lt $deadline) {
    $Process.Refresh()
    $candidateHandles = @([PrismNativeSmokeWin32]::VisibleWindowsForProcess([uint32]$Process.Id))
    if ($Process.MainWindowHandle -ne 0) {
      $candidateHandles = @($Process.MainWindowHandle) + $candidateHandles
    }
    foreach ($candidate in $candidateHandles) {
      if ($candidate -eq 0) {
        continue
      }
      $rect = Get-RectObject -Handle $candidate
      if ($rect.width -ge 780 -and $rect.height -ge 520) {
        if ($candidate -eq $stableHandle) {
          $stableCount += 1
        } else {
          $stableHandle = $candidate
          $stableCount = 1
        }
        if ($stableCount -ge $StableChecks) {
          return $candidate
        }
      }
    }
    Start-Sleep -Milliseconds 250
  }
  throw "Prism main window did not appear within $TimeoutSeconds seconds"
}

$mouseDown = 0x0002
$mouseUp = 0x0004
$process = Start-Process -FilePath $Executable -PassThru

try {
  $hwnd = Wait-ForMainWindow -Process $process
  [PrismNativeSmokeWin32]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 700
  $hwnd = Wait-ForMainWindow -Process $process -TimeoutSeconds 20 -StableChecks 1

  $visibleWindows = [PrismNativeSmokeWin32]::VisibleWindowsForProcess([uint32]$process.Id)
  $windowInfos = @($visibleWindows | ForEach-Object {
    $rect = Get-RectObject -Handle $_
    [pscustomobject]@{
      handle = $_.ToInt64()
      title = [PrismNativeSmokeWin32]::WindowTitle($_)
      className = [PrismNativeSmokeWin32]::WindowClass($_)
      width = $rect.width
      height = $rect.height
    }
  })
  $before = Get-RectObject -Handle $hwnd

  if ($before.width -lt 780 -or $before.height -lt 520) {
    throw "Unexpected Prism window size: $($before.width)x$($before.height)"
  }
  $consoleWindows = @($windowInfos | Where-Object { $_.className -eq "ConsoleWindowClass" })
  if ($consoleWindows.Count -gt 0) {
    throw "A console window is visible for Prism: $($consoleWindows | ConvertTo-Json -Compress)"
  }

  $startX = [Math]::Min($before.left + 240, $before.right - 160)
  $startY = $before.top + 24
  [PrismNativeSmokeWin32]::SetCursorPos($startX, $startY) | Out-Null
  Start-Sleep -Milliseconds 100
  [PrismNativeSmokeWin32]::mouse_event($mouseDown, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 100

  for ($i = 1; $i -le 12; $i++) {
    [PrismNativeSmokeWin32]::SetCursorPos($startX + (5 * $i), $startY + (3 * $i)) | Out-Null
    Start-Sleep -Milliseconds 25
  }

  [PrismNativeSmokeWin32]::mouse_event($mouseUp, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 800
  $after = Get-RectObject -Handle $hwnd
  $deltaX = $after.left - $before.left
  $deltaY = $after.top - $before.top

  if ([Math]::Abs($deltaX) -lt 20 -and [Math]::Abs($deltaY) -lt 15) {
    throw "Window did not move enough after titlebar drag: dx=$deltaX dy=$deltaY"
  }

  [pscustomobject]@{
    executable = $Executable
    pid = $process.Id
    visibleWindowCount = $visibleWindows.Count
    windows = $windowInfos
    before = $before
    after = $after
    deltaX = $deltaX
    deltaY = $deltaY
    titlebarDragWorks = $true
  } | ConvertTo-Json -Depth 5
}
finally {
  if ($process -and -not $process.HasExited) {
    $process.CloseMainWindow() | Out-Null
    if (-not $process.WaitForExit(5000)) {
      $process.Kill()
      $process.WaitForExit()
    }
  }
}
