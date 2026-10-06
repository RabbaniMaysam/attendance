# Daily backup of the whole database: both tools (sign-up classes, logs, undo snapshots; attendance classes, marks, answers).
# Writes a full SQL dump to backups\group-signup\ in the tools folder that contains this repository
# (F:\GDriveMay\Maysam\01_online_tools\backups\group-signup), which lives in Google Drive and is never committed.
# Restore one with:  npx wrangler d1 execute group-signup --remote --file "<that folder>\<file>.sql"
# Registered as a Windows scheduled task "group-signup backup" (see backup/README.txt).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path (Split-Path -Parent $root) 'backups\group-signup'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$file = Join-Path $out ('group-signup_' + (Get-Date -Format 'yyyy-MM-dd_HHmm') + '.sql')
$log = Join-Path $out 'last_run.log'
$flag = Join-Path $out 'BACKUP_FAILED.txt'
Set-Location (Join-Path $root 'worker')
Set-Content $log ('Backup started ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding utf8
# The Cloudflare export fails now and then (it failed at 03:00 on 2026-10-04 and 2026-10-05 and
# worked by hand the same evening); try up to five times, 10 minutes apart.
# Wrangler writes progress and errors to stderr. Under 'Stop' PowerShell 5.1 turns the first stderr
# line into a terminating error, which ended the script before any retry; so relax it for the call.
$ok = $false
foreach ($try in 1..5) {
  Add-Content $log ("`r`n--- attempt $try at " + (Get-Date -Format 'HH:mm:ss')) -Encoding utf8
  if (Test-Path $file) { Remove-Item $file }
  $ErrorActionPreference = 'Continue'
  & npx --yes wrangler d1 export group-signup --remote --output $file 2>&1 |
    ForEach-Object { ("$_" -replace "\x1b\[[0-9;]*m", '') -replace 'https://\S+', '<download link removed>' } |
    Add-Content $log -Encoding utf8
  $ErrorActionPreference = 'Stop'
  if ((Test-Path $file) -and (Get-Item $file).Length -ge 1000) { $ok = $true; break }
  if ($try -lt 5) { Start-Sleep -Seconds 600 }
}
if (-not $ok) {
  Set-Content $flag ('The backup of ' + (Get-Date -Format 'yyyy-MM-dd') + ' failed five times; see last_run.log.') -Encoding utf8
  throw "Export failed five times; see last_run.log"
}
if (Test-Path $flag) { Remove-Item $flag }
Add-Content $log ('Saved ' + (Split-Path $file -Leaf) + ', ' + (Get-Item $file).Length + ' bytes') -Encoding utf8
# Keep the newest 90 dumps (one per day), plus the first dump of every month for good.
$dumps = Get-ChildItem $out -Filter 'group-signup_*.sql' | Sort-Object Name -Descending
$monthly = $dumps | Group-Object { $_.Name.Substring(13, 7) } | ForEach-Object { ($_.Group | Sort-Object Name | Select-Object -First 1).FullName }
$dumps | Select-Object -Skip 90 | Where-Object { $monthly -notcontains $_.FullName } | Remove-Item
