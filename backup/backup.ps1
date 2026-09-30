# Daily backup of the sign-up database (all classes, logs, and undo snapshots).
# Writes a full SQL dump to backup/data/, which lives in Google Drive and is never committed.
# Restore one with:  npx wrangler d1 execute group-signup --remote --file "backup/data/<file>.sql"
# Registered as a Windows scheduled task "group-signup backup" (see backup/README.txt).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$file = Join-Path $out ('group-signup_' + (Get-Date -Format 'yyyy-MM-dd_HHmm') + '.sql')
Set-Location (Join-Path $root 'worker')
& npx --yes wrangler d1 export group-signup --remote --output $file 2>&1 | Out-File (Join-Path $out 'last_run.log')
if (-not (Test-Path $file) -or (Get-Item $file).Length -lt 1000) { throw "Export failed; see last_run.log" }
# Keep the newest 90 dumps.
Get-ChildItem $out -Filter 'group-signup_*.sql' | Sort-Object Name -Descending | Select-Object -Skip 90 | Remove-Item
