Backups of the sign-up database
===============================

Where the data lives
  Everything (classes, groups, claims, requests, the action log, and the undo
  snapshots) is stored in the Cloudflare D1 database "group-signup". It is
  persistent: signing out or closing the page changes nothing. Cloudflare also
  keeps its own point-in-time history of the database for 30 days (D1 Time
  Travel), restorable with:  npx wrangler d1 time-travel restore group-signup --timestamp <ISO time>

Daily dump into Google Drive
  backup.ps1 exports the whole database as SQL into backup/data/ (this folder
  is inside GDrive, so the dumps are synced; it is gitignored and never reaches
  the public repository). The newest 90 dumps are kept.

  Scheduled task "group-signup backup" runs it daily at 03:00 (and on the next
  start-up if the PC was off). Manage it in Task Scheduler, or:
    schtasks /Query /TN "group-signup backup"
    schtasks /Run   /TN "group-signup backup"
    schtasks /Delete /TN "group-signup backup" /F

Restoring a dump
  From the worker/ folder:
    npx wrangler d1 execute group-signup --remote --file "../backup/data/<file>.sql"
  The dump recreates the tables, so drop them first if they exist
  (npx wrangler d1 execute group-signup --remote --command "DROP TABLE classes; DROP TABLE log; DROP TABLE snapshots"),
  or restore a single class by copying its INSERT line.
