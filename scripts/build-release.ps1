param(
  [ValidateSet("nsis", "msi", "all")]
  [string]$Bundle = "nsis"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$tauriConfig = Join-Path $repoRoot "src-tauri\tauri.conf.json"
$localBuildConfig = Join-Path $repoRoot "src-tauri\tauri.build.local.json"
$tauriCli = Join-Path $repoRoot "node_modules\@tauri-apps\cli\tauri.js"
$tscCli = Join-Path $repoRoot "node_modules\typescript\bin\tsc"
$viteCli = Join-Path $repoRoot "node_modules\vite\bin\vite.js"

function Resolve-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    return $node.Source
  }

  $codexNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path -LiteralPath $codexNode -PathType Leaf) {
    return $codexNode
  }

  throw "node executable not found. Install Node via mise/Volta/asdf or add node.exe to PATH."
}

function Resolve-CargoBin {
  $cargo = Get-Command cargo -ErrorAction SilentlyContinue
  if ($cargo) {
    return Split-Path -Parent $cargo.Source
  }

  $rustupCargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
  if (Test-Path -LiteralPath $rustupCargo -PathType Leaf) {
    return Split-Path -Parent $rustupCargo
  }

  throw "cargo executable not found. Install Rust via rustup/mise or add cargo.exe to PATH."
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
  }
}

function Convert-BundleTargets {
  param([string]$Value)
  if ($Value -eq "all") {
    return "all"
  }
  return @($Value)
}

$node = Resolve-Node
$cargoBin = Resolve-CargoBin
$env:Path = "$cargoBin;$env:Path"

Push-Location $repoRoot
try {
  Invoke-Checked $node $tscCli --noEmit
  # Vite 8/Rolldown can emit absolute HTML asset names on Windows with native loader.
  Invoke-Checked $node $viteCli build --configLoader runner

  $config = Get-Content -Raw -LiteralPath $tauriConfig | ConvertFrom-Json
  $config.build.beforeBuildCommand = $null
  $config.bundle.targets = Convert-BundleTargets $Bundle
  $config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $localBuildConfig -Encoding UTF8

  Invoke-Checked $node $tauriCli build --features custom-protocol --config $localBuildConfig --bundles $Bundle
}
finally {
  Pop-Location
  Remove-Item -LiteralPath $localBuildConfig -ErrorAction SilentlyContinue
}
