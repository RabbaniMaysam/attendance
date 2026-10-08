# Daily backup of the attendance database (classes, marks, answers, log).
# Writes a full SQL dump to backups\attendance\ in the tools folder that contains this repository
# (F:\GDriveMay\Maysam\01_online_tools\backups\attendance), which lives in Google Drive and is never committed.
# Restore one with:  npx wrangler d1 execute attendance --remote --file "<that folder>\<file>.sql"
# Registered as a Windows scheduled task "attendance backup" (see backup/README.txt).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path (Split-Path -Parent $root) 'backups\attendance'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$file = Join-Path $out ('attendance_' + (Get-Date -Format 'yyyy-MM-dd_HHmm') + '.sql')
$log = Join-Path $out 'last_run.log'
$flag = Join-Path $out 'BACKUP_FAILED.txt'
Set-Location (Join-Path $root 'worker')
Set-Content $log ('Backup started ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding utf8
# Wrangler writes progress and errors to stderr. Under 'Stop' PowerShell 5.1 turns the first stderr
# line into a terminating error, which would end the script before any retry; so relax it for the calls.
# The first wrangler call of the night finds the Cloudflare sign-in token expired, refreshes it, and
# the export it then requests is refused ("Authentication error [code: 10000]"; so the group-signup
# backup at 03:00 on 2026-10-04 to 2026-10-07); the next wrangler call works. So the token is refreshed
# by a harmless call first, and the export is tried up to five times, 2 minutes apart (the scheduled
# task stops the script after 1 hour).
$ErrorActionPreference = 'Continue'
& npx --yes wrangler whoami 2>&1 | ForEach-Object { "$_" -replace "\x1b\[[0-9;]*m", '' } |
  Where-Object { $_ -match 'logged in|not authenticated|ERROR' } | Add-Content $log -Encoding utf8
$ErrorActionPreference = 'Stop'
$ok = $false
foreach ($try in 1..5) {
  Add-Content $log ("`r`n--- attempt $try at " + (Get-Date -Format 'HH:mm:ss')) -Encoding utf8
  if (Test-Path $file) { Remove-Item $file }
  $ErrorActionPreference = 'Continue'
  & npx --yes wrangler d1 export attendance --remote --output $file 2>&1 |
    ForEach-Object { ("$_" -replace "\x1b\[[0-9;]*m", '') -replace 'https://\S+', '<download link removed>' } |
    Add-Content $log -Encoding utf8
  $ErrorActionPreference = 'Stop'
  if ((Test-Path $file) -and (Get-Item $file).Length -ge 1000) { $ok = $true; break }
  if ($try -lt 5) { Start-Sleep -Seconds 120 }
}
if (-not $ok) {
  Set-Content $flag ('The backup of ' + (Get-Date -Format 'yyyy-MM-dd') + ' failed five times; see last_run.log.') -Encoding utf8
  throw "Export failed five times; see last_run.log"
}
if (Test-Path $flag) { Remove-Item $flag }
Add-Content $log ('Saved ' + (Split-Path $file -Leaf) + ', ' + (Get-Item $file).Length + ' bytes') -Encoding utf8
# Readable CSV copies of this dump in csv\ (export_csv.mjs). A failure here is logged; the dump is kept.
$ErrorActionPreference = 'Continue'
& node --no-warnings (Join-Path $PSScriptRoot 'export_csv.mjs') $file 2>&1 | ForEach-Object { "$_" } | Add-Content $log -Encoding utf8
if ($LASTEXITCODE -ne 0) { Add-Content $log 'CSV export failed (the SQL dump is fine).' -Encoding utf8 }
$ErrorActionPreference = 'Stop'
# Keep the newest 90 dumps (one per day), plus the first dump of every month for good.
# Name: attendance_YYYY-MM-DD_HHMM.sql, so the month is characters 11 to 17.
$dumps = Get-ChildItem $out -Filter 'attendance_*.sql' | Sort-Object Name -Descending
$monthly = $dumps | Group-Object { $_.Name.Substring(11, 7) } | ForEach-Object { ($_.Group | Sort-Object Name | Select-Object -First 1).FullName }
$dumps | Select-Object -Skip 90 | Where-Object { $monthly -notcontains $_.FullName } | Remove-Item
