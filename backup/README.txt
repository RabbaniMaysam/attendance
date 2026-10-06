Backups of the attendance database
==================================

Where the data lives
  Everything of the tool (classes with their settings, rosters, and questions;
  attendance marks; answers; the activity log) is stored in the Cloudflare D1
  database "attendance". It is persistent: signing out or closing the page
  changes nothing. Cloudflare also keeps its own point-in-time history of the
  database for 30 days (D1 Time Travel), restorable with:
    npx wrangler d1 time-travel restore attendance --timestamp <ISO time>
  Until 2026-10-05 the tool's data lived in the database "group-signup" of the
  group sign-up tool; its dumps up to that day are in backups\group-signup.

Daily dump into Google Drive
  backup.ps1 exports the whole database as SQL into backups\attendance\ of
  the tools folder that contains this repository
  (F:\GDriveMay\Maysam\01_online_tools\backups\attendance). That folder is in
  Google Drive, so the dumps are synced, and it is outside the repository, so
  they never reach the public repository. The newest 90 dumps are kept, plus
  the first dump of every month, which is never deleted (12 files a year).
  A failed export is retried up to five attempts, 10 minutes apart;
  last_run.log has the output of every attempt of the last run. If all five
  fail, the run writes BACKUP_FAILED.txt into that folder (the next good run
  deletes it).

  After each dump, export_csv.mjs writes readable CSV copies of it into the
  csv\ subfolder of that folder (replacing the previous set): per class the
  grid, the summary, the answers, and the log. Their columns and totals equal
  the instructor page's "Download CSV" buttons. For an older day, from this
  repository's folder:
    node --no-warnings backup/export_csv.mjs "<path of that day's .sql file>"

  Scheduled task "attendance backup" starts it daily at 03:10 (and on the next
  start-up if the PC was off; not on battery). Manage it in Task Scheduler, or:
    schtasks /Query /TN "attendance backup"
    schtasks /Run   /TN "attendance backup"
    schtasks /Delete /TN "attendance backup" /F

Per-class download from the instructor page
  The Reports tab of the instructor page has "Download everything": one JSON
  file with the class's settings, roster, every mark, every answer, and the
  whole log. The page shows a reminder at the top after 60 days without such a
  download (or without ticking "I saved it elsewhere").

Restoring a dump
  From the worker/ folder:
    npx wrangler d1 execute attendance --remote --file "../../backups/attendance/<file>.sql"
  The dump recreates the tables, so drop them first if they exist
  (npx wrangler d1 execute attendance --remote --command "DROP TABLE att_classes; DROP TABLE att_marks; DROP TABLE att_answers; DROP TABLE log"),
  or restore a single class by copying its INSERT lines (att_marks rows are
  keyed by class, round, and email; the log rows of a class have
  class = 'att:' followed by the key).
