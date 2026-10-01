Backups of the database (sign-up tool and attendance tool)
==========================================================

Where the data lives
  Everything of both tools (sign-up classes, groups, claims, requests, the
  action log, and the undo snapshots; attendance classes, marks, answers, and
  the attendance log) is stored in the one Cloudflare D1 database
  "group-signup". It is persistent: signing out or closing the page changes
  nothing. Cloudflare also keeps its own point-in-time history of the database
  for 30 days (D1 Time Travel), restorable with:
    npx wrangler d1 time-travel restore group-signup --timestamp <ISO time>

Daily dump into Google Drive
  backup.ps1 exports the whole database as SQL into backup/data/ (this folder
  is inside GDrive, so the dumps are synced; it is gitignored and never reaches
  the public repository). A dump is about 0.5 MB. The newest 90 dumps are kept,
  plus the first dump of every month, which is never deleted (12 files a year).
  A failed export is retried twice, 90 seconds apart; last_run.log has the
  output of the last attempt.

  Scheduled task "group-signup backup" runs it daily at 03:00 (and on the next
  start-up if the PC was off; not on battery). Manage it in Task Scheduler, or:
    schtasks /Query /TN "group-signup backup"
    schtasks /Run   /TN "group-signup backup"
    schtasks /Delete /TN "group-signup backup" /F

Per-class download from the attendance page
  The Reports tab of the attendance instructor page has "Download everything":
  one JSON file with the class's settings, roster, every mark, every answer,
  and the whole log. The page shows a reminder at the top after 60 days without
  such a download (or without ticking "I saved it elsewhere").

Restoring a dump
  From the worker/ folder:
    npx wrangler d1 execute group-signup --remote --file "../backup/data/<file>.sql"
  The dump recreates the tables, so drop them first if they exist
  (npx wrangler d1 execute group-signup --remote --command "DROP TABLE classes; DROP TABLE log; DROP TABLE snapshots; DROP TABLE att_classes; DROP TABLE att_marks; DROP TABLE att_answers"),
  or restore a single class by copying its INSERT lines (att_marks rows are
  keyed by class, round, and email; the log rows of an attendance class have
  class = 'att:' followed by the key).
