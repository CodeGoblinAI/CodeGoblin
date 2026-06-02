# CodeGoblin installer — installs the published npm meta package globally.
param(
  [string]$Version = $env:VERSION,
  [string]$Package = $(if ($env:CODEGOBLIN_NPM_PACKAGE) { $env:CODEGOBLIN_NPM_PACKAGE } else { "codegoblin" }),
  [string]$Tag = $(if ($env:CODEGOBLIN_NPM_TAG) { $env:CODEGOBLIN_NPM_TAG } else { "latest" })
)

if (-not $Version) { $Version = "latest" }

if ($Version -eq "latest" -and $Tag -and $Tag -ne "latest") {
  $spec = "${Package}@${Tag}"
} else {
  $spec = "${Package}@${Version}"
}

Write-Host "Installing CodeGoblin ($spec)..."

function Invoke-Install {
  param([string]$Command, [string[]]$Args)
  & $Command @Args
  if ($LASTEXITCODE -ne 0) { throw "Install failed with exit code $LASTEXITCODE" }
}

if (Get-Command npm -ErrorAction SilentlyContinue) {
  Invoke-Install npm @("install", "-g", $spec)
} elseif (Get-Command bun -ErrorAction SilentlyContinue) {
  Invoke-Install bun @("install", "-g", $spec)
} elseif (Get-Command pnpm -ErrorAction SilentlyContinue) {
  Invoke-Install pnpm @("install", "-g", $spec)
} else {
  Write-Error "npm, bun, or pnpm is required."
  exit 1
}

Write-Host ""
Write-Host "Installed. Run: codegoblin --help"
