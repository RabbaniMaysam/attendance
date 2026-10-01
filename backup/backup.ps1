# Daily backup of the whole database: both tools (sign-up classes, logs, undo snapshots; attendance classes, marks, answers).
# Writes a full SQL dump to backup/data/, which lives in Google Drive and is never committed.
# Restore one with:  npx wrangler d1 execute group-signup --remote --file "backup/data/<file>.sql"
# Registered as a Windows scheduled task "group-signup backup" (see backup/README.txt).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$file = Join-Path $out ('group-signup_' + (Get-Date -Format 'yyyy-MM-dd_HHmm') + '.sql')
$log = Join-Path $out 'last_run.log'
Set-Location (Join-Path $root 'worker')
# The export sometimes fails (network, Cloudflare); try up to three times, 90 seconds apart.
foreach ($try in 1..3) {
  & npx --yes wrangler d1 export group-signup --remote --output $file 2>&1 | Out-File $log
  if ((Test-Path $file) -and (Get-Item $file).Length -ge 1000) { break }
  if ($try -eq 3) { throw "Export failed three times; see last_run.log" }
  Start-Sleep -Seconds 90
}
# Keep the newest 90 dumps (one per day), plus the first dump of every month for good.
$dumps = Get-ChildItem $out -Filter 'group-signup_*.sql' | Sort-Object Name -Descending
$monthly = $dumps | Group-Object { $_.Name.Substring(13, 7) } | ForEach-Object { ($_.Group | Sort-Object Name | Select-Object -First 1).FullName }
$dumps | Select-Object -Skip 90 | Where-Object { $monthly -notcontains $_.FullName } | Remove-Item
