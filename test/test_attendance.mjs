// Tests the attendance rules (session windows in New York time, session list edits, roster import).
//   node test/test_attendance.mjs
import * as att from '../worker/src/attendance.js';
import { canonEmail } from '../worker/src/rules.js';

let pass = 0, fail = 0;
const ok = (cond, label) => { cond ? pass++ : (fail++, console.log('FAIL:', label)); };
const throws = (fn, re, label) => { try { fn(); ok(false, label + ' (no error)'); } catch (e) { ok(re.test(e.message), label + ': ' + e.message); } };
// New York instants: EDT (UTC-4) in October, EST (UTC-5) in December.
const edt = (date, hhmm) => Date.parse(date + 'T' + hhmm + ':00-04:00');
const est = (date, hhmm) => Date.parse(date + 'T' + hhmm + ':00-05:00');

const s = att.newAttClass('ECON 101');
ok(s.sessions.length === 0 && s.roster.length === 0, 'a new class has no sessions');

let p = att.nyParts(edt('2026-10-06', '07:50'));
ok(p.date === '2026-10-06' && p.weekday === 2 && p.minutes === 470, 'New York parts in EDT');
p = att.nyParts(est('2026-12-01', '00:30'));
ok(p.date === '2026-12-01' && p.minutes === 30, 'New York parts in EST, just after midnight');
p = att.nyParts(Date.parse('2026-12-01T03:00:00Z'));  // 10 pm the evening before in New York
ok(p.date === '2026-11-30' && p.minutes === 22 * 60, 'UTC date differs from the New York date');

// session list: 2026-10-06 (Tue), 10-08 (Thu), 12-01 (Tue), two windows on 10-13, a duplicate row, given out of order
att.ADMIN.saveSessions(s, [
  { date: '2026-10-08', open: '07:50', close: '08:01' },
  { date: '2026-10-06', open: '7:50', close: '8:01' },
  { date: '2026-10-13', open: '13:00', close: '13:10' },
  { date: '2026-10-13', open: '07:50', close: '08:01' },
  { date: '2026-12-01', open: '07:50', close: '08:01' },
  { date: '2026-10-06', open: '07:50', close: '08:01' }]);
ok(s.sessions.length === 5 && s.sessions[0].date === '2026-10-06' && s.sessions[0].open === '07:50' && s.sessions[2].open === '07:50' && s.sessions[3].open === '13:00',
  'sessions: times padded, duplicate merged, sorted by date then time: ' + s.sessions.map(x => x.date + ' ' + x.open).join(', '));

ok(att.windowAt(s, edt('2026-10-06', '07:49')) === null, 'closed one minute before opening');
let w = att.windowAt(s, edt('2026-10-06', '07:50'));
ok(w && w.date === '2026-10-06' && w.close === '08:01', 'open at 7:50');
ok(att.windowAt(s, edt('2026-10-06', '08:00')) !== null, 'open at 8:00');
ok(att.windowAt(s, edt('2026-10-06', '08:01')) === null, 'closed at 8:01');
ok(att.windowAt(s, edt('2026-10-07', '07:55')) === null, 'closed on a day with no session');
ok(att.windowAt(s, edt('2026-10-13', '13:05')) !== null && att.windowAt(s, edt('2026-10-13', '07:55')) !== null, 'both windows on one day open');
ok(att.windowAt(s, est('2026-12-01', '07:55')) !== null, 'open in December (EST)');
ok(att.windowAt(s, Date.parse('2026-12-01T12:55:00Z')) !== null && att.windowAt(s, Date.parse('2026-10-06T12:55:00Z')) === null,
  '12:55 UTC is 7:55 New York in December but 8:55 in October');

let nx = att.nextWindow(s, edt('2026-10-06', '08:01'));
ok(nx && nx.date === '2026-10-08' && nx.open === '07:50' && nx.daysAhead === 2, 'next window after Tuesday close is Thursday: ' + JSON.stringify(nx));
nx = att.nextWindow(s, edt('2026-10-06', '07:00'));
ok(nx && nx.date === '2026-10-06' && nx.daysAhead === 0, 'next window earlier the same day');
nx = att.nextWindow(s, edt('2026-10-13', '08:30'));
ok(nx && nx.date === '2026-10-13' && nx.open === '13:00', 'second window of the day is next after the first closes');
ok(att.nextWindow(s, est('2026-12-01', '09:00')) === null, 'no next window after the last session');

let r = att.refreshIn(s, edt('2026-10-06', '07:55') + 20000);
ok(r > 5 * 60000 && r < 6 * 60000 + 2000, 'refresh at the close time while open: ' + r);
r = att.refreshIn(s, edt('2026-10-06', '07:40'));
ok(r > 9 * 60000 && r < 11 * 60000, 'refresh at the open time while closed: ' + r);
ok(att.refreshIn(s, edt('2026-10-06', '09:00')) === 6 * 3600000, 'refresh capped at 6 hours when the next window is days away');
ok(att.refreshIn(s, est('2026-12-02', '09:00')) === 6 * 3600000, 'refresh capped when nothing is scheduled');

throws(() => att.ADMIN.saveSessions(s, [{ date: '2026-10-06', open: '08:01', close: '07:50' }]), /after the open/, 'close before open refused');
throws(() => att.ADMIN.saveSessions(s, [{ date: 'Oct 6', open: '07:50', close: '08:01' }]), /not a date/, 'bad date refused');
throws(() => att.ADMIN.saveSessions(s, [{ date: '2026-10-06', open: '7:50 am', close: '08:01' }]), /HH:MM/, 'bad time refused');
ok(s.sessions.length === 5, 'refused list leaves the sessions unchanged');
throws(() => att.ADMIN.saveTitle(s, ' '), /title/, 'empty title refused');

// open now
w = att.openNowWindow(edt('2026-10-07', '14:03') + 5000, 10);
ok(w.date === '2026-10-07' && w.open === '14:03' && w.close === '14:13', 'open now for 10 minutes: ' + JSON.stringify(w));
att.ADMIN.addSession(s, w.date, w.open, w.close);
ok(s.sessions.length === 6 && att.windowAt(s, edt('2026-10-07', '14:08')) !== null, 'open-now session added');

// session dates: sessions through today plus dates with marks
let dates = att.sessionDates(s, ['2026-09-30'], edt('2026-10-13', '12:00'));
ok(dates.join(' ') === '2026-09-30 2026-10-06 2026-10-07 2026-10-08 2026-10-13', 'session dates: ' + dates.join(' '));

// roster, Montclair addresses, and student view
ok(canonEmail(' Jane@Mail.Montclair.EDU ') === 'jane@montclair.edu' && canonEmail('x@gmail.com') === 'x@gmail.com', 'mail.montclair.edu is folded into montclair.edu');
att.ADMIN.importRoster(s, 'Email,First Name,Last Name\nB@X.EDU,Bea,Zeta\na@mail.montclair.edu,Al,Alpha\n\na@montclair.edu,Dup,Dup');
ok(s.roster.length === 2 && s.roster[0].email === 'a@montclair.edu' && s.roster[1].last === 'Zeta', 'roster import: lowercased, folded, deduplicated, sorted by last name');
ok(att.student(s, 'A@mail.montclair.edu').first === 'Al', 'a mail.montclair.edu sign-in matches the montclair.edu roster entry');
let v = att.studentView(s, 'nobody@x.edu', null, edt('2026-10-06', '07:55'));
ok(v.authorized === false, 'unknown account refused');
v = att.studentView(s, 'a@montclair.edu', null, edt('2026-10-06', '07:55'));
ok(v.authorized && v.name === 'Al Alpha' && v.open && v.open.close === '08:01' && v.marked === '' && v.next === null, 'student view while open');
v = att.studentView(s, 'a@montclair.edu', { time: '2026-10-06T11:52:00Z' }, edt('2026-10-06', '08:30'));
ok(!v.open && v.marked === '2026-10-06T11:52:00Z' && v.next.date === '2026-10-07', 'student view after closing, marked, next window shown');

console.log('passed', pass, 'failed', fail);
process.exit(fail ? 1 : 0);
