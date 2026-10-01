-- One row per class. state is the class's JSON state (see src/rules.js).
-- version and stamp implement the compare-and-write in src/index.js.
CREATE TABLE IF NOT EXISTS classes (
  key     TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  stamp   TEXT NOT NULL DEFAULT '',
  state   TEXT NOT NULL
);

-- Activity history: every sign-in, action, and refused attempt.
CREATE TABLE IF NOT EXISTS log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  time   TEXT NOT NULL,
  class  TEXT NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS log_class ON log (class, id);

-- Before every change, the class state as it was, so the instructor can restore any earlier point.
CREATE TABLE IF NOT EXISTS snapshots (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  time   TEXT NOT NULL,
  class  TEXT NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  state  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS snap_class ON snapshots (class, id);

-- Attendance tool (src/attendance.js): one row per attendance class, settings and roster as JSON.
CREATE TABLE IF NOT EXISTS att_classes (
  key   TEXT PRIMARY KEY,
  state TEXT NOT NULL
);

-- One row per student per attendance round (round = 'YYYY-MM-DD HH:MM', the window's date and opening time).
-- self = when the student pressed the button (NULL if never); present = the current value (1 or 0);
-- edited and by = time and account of the instructor's last manual change (NULL if none).
-- present - (self IS NOT NULL) is the manual change: +1 marked present by hand, -1 set absent by hand,
-- 0 when the value equals what the student did. A row that is absent with no self mark is deleted.
CREATE TABLE IF NOT EXISTS att_marks (
  class   TEXT NOT NULL,
  round   TEXT NOT NULL,
  email   TEXT NOT NULL,
  self    TEXT,
  present INTEGER NOT NULL DEFAULT 1,
  edited  TEXT,
  by      TEXT,
  PRIMARY KEY (class, round, email)
);

-- One row per student per in-class question (qid = question id in the class state); the latest answer wins.
CREATE TABLE IF NOT EXISTS att_answers (
  class  TEXT NOT NULL,
  qid    TEXT NOT NULL,
  email  TEXT NOT NULL,
  answer TEXT NOT NULL,
  time   TEXT NOT NULL,
  PRIMARY KEY (class, qid, email)
);
