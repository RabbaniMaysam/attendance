// Tests the attendance rules (windows in New York time, schedule edits, roster import).
//   node test/test_attendance.mjs
import * as att from '../worker/src/attendance.js';

let pass = 0, fail = 0;
const ok = (cond, label) => { cond ? pass++ : (fail++, console.log('FAIL:', label)); };
const throws = (fn, re, label) => { try { fn(); ok(false, label + ' (no error)'); } catch (e) { ok(re.test(e.message), label + ': ' + e.message); } };
// New York instants: EDT (UTC-4) in October, EST (UTC-5) in December.
const edt = (date, hhmm) => Date.parse(date + 'T' + hhmm + ':00-04:00');
const est = (date, hhmm) => Date.parse(date + 'T' + hhmm + ':00-05:00');

// 2026-10-06 is a Tuesday, 2026-10-08 a Thursday, 2026-10-07 a Wednesday.
const s = att.newAttClass('ECON 101', edt('2026-09-01', '10:00'));
ok(s.schedule.days.join() === '2,4' && s.schedule.open === '07:50' && s.schedule.close === '08:01' && s.createdAt === '2026-09-01', 'defaults: Tue/Thu 7:50 to 8:01');

let p = att.nyParts(edt('2026-10-06', '07:50'));
ok(p.date === '2026-10-06' && p.weekday === 2 && p.minutes === 470, 'New York parts in EDT');
p = att.nyParts(est('2026-12-01', '00:30'));
ok(p.date === '2026-12-01' && p.weekday === 2 && p.minutes === 30, 'New York parts in EST, just after midnight');
p = att.nyParts(Date.parse('2026-12-01T03:00:00Z'));  // 10 pm the evening before in New York
ok(p.date === '2026-11-30' && p.weekday === 1 && p.minutes === 22 * 60, 'UTC date differs from the New York date');

ok(att.windowAt(s, edt('2026-10-06', '07:49')) === null, 'closed one minute before opening');
let w = att.windowAt(s, edt('2026-10-06', '07:50'));
ok(w && w.date === '2026-10-06' && w.close === '08:01', 'open at 7:50 on a Tuesday');
ok(att.windowAt(s, edt('2026-10-06', '08:00')) !== null, 'open at 8:00');
ok(att.windowAt(s, edt('2026-10-06', '08:01')) === null, 'closed at 8:01');
ok(att.windowAt(s, edt('2026-10-07', '07:55')) === null, 'closed on a Wednesday');
ok(att.windowAt(s, edt('2026-10-08', '07:55')) !== null, 'open on a Thursday');
ok(att.windowAt(s, est('2026-12-01', '07:55')) !== null, 'open on a Tuesday in December (EST)');
ok(att.windowAt(s, Date.parse('2026-12-01T12:55:00Z')) !== null && att.windowAt(s, Date.parse('2026-10-06T12:55:00Z')) === null,
  '12:55 UTC is 7:55 New York in December but 8:55 in October');

let nx = att.nextWindow(s, edt('2026-10-06', '08:01'));
ok(nx && nx.date === '2026-10-08' && nx.open === '07:50' && nx.daysAhead === 2, 'next window after Tuesday close is Thursday: ' + JSON.stringify(nx));
nx = att.nextWindow(s, edt('2026-10-06', '07:00'));
ok(nx && nx.date === '2026-10-06' && nx.daysAhead === 0, 'next window earlier the same day');
nx = att.nextWindow(s, edt('2026-10-08', '09:00'));
ok(nx && nx.date === '2026-10-13', 'next window after Thursday is next Tuesday');

let r = att.refreshIn(s, edt('2026-10-06', '07:55') + 20000);
ok(r > 5 * 60000 && r < 6 * 60000 + 2000, 'refresh at the close time while open: ' + r);
r = att.refreshIn(s, edt('2026-10-06', '07:40'));
ok(r > 9 * 60000 && r < 11 * 60000, 'refresh at the open time while closed: ' + r);
ok(att.refreshIn(s, edt('2026-10-06', '09:00')) === 6 * 3600000, 'refresh capped at 6 hours when the next window is days away');

// settings: skip a holiday, semester bounds, validation
att.ADMIN.saveSettings(s, { title: 'ECON 101', days: [2, 4], open: '07:50', close: '08:01', start: '2026-09-01', end: '2026-12-15', skip: '2026-11-26, 2026-10-08' });
ok(att.windowAt(s, edt('2026-10-08', '07:55')) === null && att.windowAt(s, edt('2026-10-13', '07:55')) !== null, 'skipped date is closed');
ok(att.nextWindow(s, edt('2026-10-06', '09:00')).date === '2026-10-13', 'next window skips the holiday');
ok(att.windowAt(s, est('2026-12-17', '07:55')) === null && att.windowAt(s, est('2026-12-15', '07:55')) !== null, 'closed after the semester end');
throws(() => att.ADMIN.saveSettings(s, { title: 'x', days: [2], open: '08:01', close: '07:50', skip: '' }), /after the open/, 'close before open refused');
throws(() => att.ADMIN.saveSettings(s, { title: 'x', days: [2], open: '7:50', close: '8:01', skip: 'Nov 26' }), /not a date/, 'bad skip date refused');
throws(() => att.ADMIN.saveSettings(s, { title: '', days: [2], open: '07:50', close: '08:01' }), /title/, 'empty title refused');

// extra window on a Wednesday, and "open now"
att.ADMIN.addExtra(s, '2026-10-07', '13:00', '13:10');
ok(att.windowAt(s, edt('2026-10-07', '13:05')) !== null && att.windowAt(s, edt('2026-10-07', '13:10')) === null, 'extra window opens and closes');
att.ADMIN.removeExtra(s, '2026-10-07');
ok(att.windowAt(s, edt('2026-10-07', '13:05')) === null, 'extra window removed');
w = att.openNowWindow(edt('2026-10-07', '14:03') + 5000, 10);
ok(w.date === '2026-10-07' && w.open === '14:03' && w.close === '14:13', 'open now for 10 minutes: ' + JSON.stringify(w));

// session dates: scheduled Tue/Thu from the start through today, minus the holiday, plus dates with marks
let dates = att.sessionDates(s, ['2026-09-30'], edt('2026-10-13', '12:00'));
ok(dates[0] === '2026-09-01' && dates.indexOf('2026-09-30') !== -1 && dates.indexOf('2026-10-08') === -1 && dates[dates.length - 1] === '2026-10-13' && dates.length === 13,
  'session dates: ' + dates.join(' '));

// roster and student view
att.ADMIN.importRoster(s, 'Email,First Name,Last Name\nB@X.EDU,Bea,Zeta\na@x.edu,Al,Alpha\n\na@x.edu,Dup,Dup');
ok(s.roster.length === 2 && s.roster[0].email === 'a@x.edu' && s.roster[1].last === 'Zeta', 'roster import: lowercased, deduplicated, sorted by last name');
let v = att.studentView(s, 'nobody@x.edu', null, edt('2026-10-06', '07:55'));
ok(v.authorized === false, 'unknown account refused');
v = att.studentView(s, 'a@x.edu', null, edt('2026-10-06', '07:55'));
ok(v.authorized && v.name === 'Al Alpha' && v.open && v.open.close === '08:01' && v.marked === '' && v.next === null, 'student view while open');
v = att.studentView(s, 'a@x.edu', { time: '2026-10-06T11:52:00Z' }, edt('2026-10-06', '08:30'));
ok(!v.open && v.marked === '2026-10-06T11:52:00Z' && v.next.date === '2026-10-13', 'student view after closing, marked, next window shown');

// Canvas export and the two Montclair domains
att.ADMIN.importRoster(s, 'Student,SIS Login ID,Quiz 1\n"    Points Possible",,10\n"Student, Test",843b2ebf97d6dff55e1ba2ce8c7910f987d72b05,\n"Lafontaine Medina, Elian",lafontaineme1,\n"Khan, Jubair",khanj6,');
ok(s.roster.length === 2 && s.roster[0].email === 'khanj6@montclair.edu' && s.roster[1].first === 'Elian' && s.roster[1].last === 'Lafontaine Medina',
  'Canvas roster: test student and Points Possible skipped, names split, login becomes montclair.edu address');
ok(att.studentView(s, 'KhanJ6@mail.montclair.edu', null, edt('2026-10-06', '07:55')).authorized, 'mail.montclair.edu sign-in matches the montclair.edu roster');

console.log('passed', pass, 'failed', fail);
process.exit(fail ? 1 : 0);
