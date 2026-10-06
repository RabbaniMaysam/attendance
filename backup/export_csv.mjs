// Readable CSV copies of a database dump, written by backup.ps1 after each daily dump.
//   node --no-warnings backup/export_csv.mjs [dump.sql]
// Without an argument it reads the newest dump in ..\backups\attendance. The files go to
// ..\backups\attendance\csv\ and replace the previous set; to see an older day, run it on that day's dump.
// The files reuse the tool's own functions (worker/src/attendance.js), so their counts and
// points equal the instructor page's, and their columns equal the page's "Download CSV" buttons.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as att from '../worker/src/attendance.js';

const here = dirname(fileURLToPath(import.meta.url));
const store = join(here, '..', '..', 'backups', 'attendance');
const dump = process.argv[2] || join(store, readdirSync(store).filter(f => /^attendance_.*\.sql$/.test(f)).sort().pop());
const out = join(store, 'csv');

// The dump's moment, from its name (New York time): the attendance rounds are counted up to it.
const m = /(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})\.sql$/.exec(basename(dump));
let now = Date.now();
if (m) {
  now = ['-04:00', '-05:00'].map(z => Date.parse(m[1] + 'T' + m[2] + ':' + m[3] + ':00' + z))
    .find(ms => att.nyParts(ms).date === m[1] && att.nyParts(ms).minutes === Number(m[2]) * 60 + Number(m[3])) ?? now;
}

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(dump, 'utf8'));
const all = (sql, ...a) => db.prepare(sql).all(...a);

const TZ = 'America/New_York';
const isoFull = iso => new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(iso));
const isoClock = iso => new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const clock = hhmm => { const h = Number(hhmm.split(':')[0]); return ((h + 11) % 12 + 1) + ':' + hhmm.split(':')[1] + (h < 12 ? ' am' : ' pm'); };
const num = (x, d) => (Math.round(x * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d);
const safe = k => String(k).replace(/[^A-Za-z0-9_.-]/g, '_');

let files = 0;
function write(name, rows) {
  const csv = rows.map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
  writeFileSync(join(out, name), '﻿' + csv + '\r\n');  // the byte-order mark makes Excel read the names as UTF-8
  files++;
}
function logRows(cls) {
  return [['Time (New York)', 'Time (ISO)', 'Account', 'Action', 'Detail']].concat(
    all('SELECT time, actor, action, detail FROM log WHERE class = ? ORDER BY time, id', cls).map(r => [isoFull(r.time), r.time, r.actor, r.action, r.detail]));
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const row of all('SELECT key, state FROM att_classes ORDER BY key')) {
  const k = row.key, s = att.upgradeAtt(JSON.parse(row.state));
  const marks = all('SELECT round, email, self, present, edited, by FROM att_marks WHERE class = ? ORDER BY round, email', k);
  const ids = marks.map(x => x.round).filter((d, i, a) => a.indexOf(d) === i);
  const rounds = att.rounds(s, ids, now);
  const R = att.report(s, rounds, marks, now);
  const counted = x => s.exclude.indexOf(x.date) === -1;
  const cnt = rounds.filter(counted);
  const byKey = {};
  marks.forEach(x => { byKey[x.round + '|' + x.email] = x; });
  const changeOf = x => x ? (x.present ? 1 : 0) - (x.self ? 1 : 0) : 0;

  // The grid: present (1/0) and the manual change (+1, -1, 0) per round, then the totals (as the Attendance tab's CSV).
  const head = ['Last name', 'First name', 'Email'];
  rounds.forEach(x => { const l = x.date + ' ' + clock(x.open) + (counted(x) ? '' : ' (excluded)'); head.push(l, l + ' change'); });
  head.push('Present', 'Rounds', 'Percent', 'Changes', 'Points', 'Possible so far', 'Total points');
  write('attendance_' + safe(k) + '_grid.csv', [head].concat(s.roster.map(r => {
    const line = [r.last, r.first, r.email], st = R.students[r.email];
    let n = 0, edits = 0;
    rounds.forEach(x => {
      const mk = byKey[x.id + '|' + r.email], c = changeOf(mk);
      if (mk && mk.present && counted(x)) n++;
      if (c) edits++;
      line.push(mk && mk.present ? 1 : 0, c);
    });
    return line.concat([n, cnt.length, cnt.length ? num(100 * n / cnt.length, 1) : '', edits, num(st.points, 3), num(st.possible, 3), num(R.total, 3)]);
  })));

  // One line per student (as the Reports tab's CSV).
  write('attendance_' + safe(k) + '_summary.csv', [['Last name', 'First name', 'Email', 'Present', 'Rounds', 'Percent', 'Points', 'Possible so far', 'Total points']]
    .concat(s.roster.map(r => { const st = R.students[r.email];
      return [r.last, r.first, r.email, st.present, st.rounds, num(st.rounds ? 100 * st.present / st.rounds : 0, 1), num(st.points, 3), num(st.possible, 3), num(R.total, 3)]; })));

  // In-class answers, one column per question (as the Questions tab's CSV).
  if (s.questions.length) {
    const ans = all('SELECT qid, email, answer FROM att_answers WHERE class = ?', k);
    const qhead = ['Last name', 'First name', 'Email'].concat(s.questions.map((q, i) => 'Q' + (i + 1) + ' ' + isoClock(q.opened)), ['Answered', 'Right']);
    const rows = [qhead].concat(s.roster.map(r => {
      const cells = s.questions.map(q => { const a = ans.find(x => x.qid === q.id && x.email === r.email); return a ? a.answer : ''; });
      return [r.last, r.first, r.email].concat(cells, [cells.filter(Boolean).length, s.questions.filter((q, i) => att.isRight(q, cells[i])).length]);
    }));
    rows.push(['Correct answer', '', ''].concat(s.questions.map(q => q.correct)));
    rows.push(['Text', '', ''].concat(s.questions.map(q => q.text)));
    write('attendance_' + safe(k) + '_answers.csv', rows);
  }
  write('attendance_' + safe(k) + '_log.csv', logRows('att:' + k));
}

writeFileSync(join(out, 'README.txt'),
  'Readable copies of the database dump ' + basename(dump) + ', written ' + new Date().toISOString() + '.\r\n' +
  'They are replaced at every daily backup. For an older day, run from the attendance folder:\r\n' +
  '  node --no-warnings backup/export_csv.mjs "<path of that day\'s .sql file>"\r\n' +
  'attendance_<class>_grid: one column per round (1 = present) and its manual change (+1/-1); summary: totals and points;\r\n' +
  'answers: in-class questions; log: every action, oldest first.\r\n');
console.log('Wrote ' + files + ' CSV files from ' + basename(dump) + ' to ' + out);
