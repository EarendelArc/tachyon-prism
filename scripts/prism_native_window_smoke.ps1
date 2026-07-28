param(
  [string]$Executable = "",
  [ValidateSet("L1", "L2", "Strict")]
  [string]$Level = "L1",
  [string]$Out = ""
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

$smoke = Join-Path $PSScriptRoot "prism_native_window_smoke.py"
$arguments = @($smoke, "--executable", $Executable, "--level", $Level.ToLowerInvariant())
if (-not [string]::IsNullOrWhiteSpace($Out)) {
  $arguments += @("--out", [System.IO.Path]::GetFullPath($Out))
}
& python @arguments
$exitCode = $LASTEXITCODE
if ($exitCode -eq 2) {
  Write-Warning "Prism native $Level gate is blocked by foreground/UIPI policy; inspect its RESULT.json."
  exit 2
}
if ($exitCode -ne 0) {
  throw "Prism native window smoke failed with exit code $exitCode"
}
