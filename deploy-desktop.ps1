<#
.SYNOPSIS
  Deploy this repo's plugin code into the desktop profile, refreshing the pnpm
  hard copy that DSH actually loads, then print the restart reminder.

.DESCRIPTION
  Why this exists: the profile installs this plugin as a pnpm "file:" dependency,
  and pnpm COPIES the package into
    <profile>\node_modules\.pnpm\dsh-team-link@file+...\node_modules\dsh-team-link
  DSH loads THAT copy, so "edit code -> restart" does NOT take effect until the
  copy is refreshed. This script does the refresh.

  Steps (-DryRun prints only; writes nothing, changes no git state):
    1. fast-forward the deploy clone from this repo (local path, no network)
    2. copy lib\ + package.json + cordis.patch.yml into the pnpm copy
    3. verify lib\index.js sha256 matches on both sides
    4. print the restart reminder

  NOTE (why the messages are ASCII): Windows PowerShell 5.1 reads a BOM-less
  UTF-8 file as GBK, which mangles non-ASCII text and can even break parsing.
  This script is pure ASCII so it runs identically under powershell.exe and pwsh.

.PARAMETER Src
  This repo. Defaults to the folder containing this script.

.PARAMETER Clone
  The deploy clone. Default: C:\Users\magic\.dsh-plugins\dsh-team-link

.PARAMETER Profile
  Profile folder that owns node_modules. Default: C:\Users\magic\.dsh\profiles\desktop

.PARAMETER DryRun
  Print what would happen; write nothing.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy-desktop.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File deploy-desktop.ps1
#>
[CmdletBinding()]
param(
  [string]$Src = "",
  [string]$Clone = "C:\Users\magic\.dsh-plugins\dsh-team-link",
  [string]$Profile = "C:\Users\magic\.dsh\profiles\desktop",
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
# $MyInvocation is null inside a param() default, so resolve the script folder here.
if ([string]::IsNullOrEmpty($Src)) { $Src = $PSScriptRoot }
function Info($m) { Write-Host $m }
function Sha($p) { if (Test-Path $p) { (Get-FileHash $p -Algorithm SHA256).Hash.ToLower() } else { "" } }

if (-not (Test-Path (Join-Path $Src "lib\index.js"))) { throw "Src is not this repo: $Src" }
if (-not (Test-Path (Join-Path $Clone "lib\index.js"))) { throw "Clone missing or not the plugin: $Clone" }

$store = Get-ChildItem (Join-Path $Profile "node_modules\.pnpm") -Directory -ErrorAction SilentlyContinue |
         Where-Object { $_.Name -like "dsh-team-link@*" } | Select-Object -First 1
if ($null -eq $store) { throw "pnpm copy not found under: $Profile\node_modules\.pnpm\dsh-team-link@*" }
$Pkg = Join-Path $store.FullName "node_modules\dsh-team-link"

Info "repo       : $Src"
Info "deploy clone: $Clone"
Info "pnpm copy  : $Pkg"
if ($DryRun) { Info "(DryRun: print only, nothing is written)" }

$srcRev = (& git -C $Src rev-parse --short HEAD).Trim()
Info ""
Info "[1/4] repo HEAD = $srcRev"
if ($DryRun) {
  $rc = (& git -C $Clone rev-parse --short HEAD).Trim()
  Info ("      (dry-run) would run: git -C " + $Clone + " fetch " + $Src + " main; git -C " + $Clone + " merge --ff-only FETCH_HEAD")
  Info "      (deploy clone HEAD is currently $rc)"
} else {
  & git -C $Clone fetch $Src main 2>&1 | Out-Null
  & git -C $Clone merge --ff-only FETCH_HEAD 2>&1 | Out-String | Write-Host
}
$cloneRevNow = (& git -C $Clone rev-parse --short HEAD).Trim()
Info "      deploy clone HEAD = $cloneRevNow"

$files = @("lib\index.js", "lib\client.js", "package.json", "cordis.patch.yml")
Info ""
Info "[2/4] refresh the pnpm copy ($($files.Count) runtime files)"
foreach ($f in $files) {
  $s = Join-Path $Clone $f; $d = Join-Path $Pkg $f
  $hs = Sha $s
  if ($hs -eq "") { Info ("      - {0}: source missing, skipped" -f $f); continue }
  $changed = (Sha $d) -ne $hs
  $tag = "already in sync"; if ($changed) { $tag = "updated" }
  Info ("      - {0}: {1}" -f $f, $tag)
  if ($changed -and -not $DryRun) {
    $dd = Split-Path -Parent $d
    if (-not (Test-Path $dd)) { New-Item -ItemType Directory -Force $dd | Out-Null }
    Copy-Item $s $d -Force
  }
}

Info ""
Info "[3/4] verify sha256"
$srcLib = Sha (Join-Path $Clone "lib\index.js")
$dstLib = Sha (Join-Path $Pkg "lib\index.js")
Info "      deploy clone lib\index.js = $srcLib"
Info "      pnpm copy    lib\index.js = $dstLib"
if ($srcLib -ne $dstLib) { throw "MISMATCH: the two lib\index.js differ" }
Info "      OK: identical"

Info ""
Info "[4/4] done -- takes effect after a DSH restart (the running process holds the old module)"
Info "      deployed: $cloneRevNow (repo $srcRev)"
Info ("      rollback: git -C " + $Clone + " checkout <old-rev>  then re-run this script")
