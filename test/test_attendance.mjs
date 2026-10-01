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
ok(s.schedule.days.join() === '2,4' && s.schedule.open === '07:50' && s.schedule.close === '08:05' && s.schedule.start === '2026-10-01' && s.schedule.end === '2026-12-08'
  && s.skip.length === 5 && s.createdAt === '2026-09-01', 'defaults: Tue/Thu 7:50 to 8:05, Oct 1 to Dec 8, five no-class days');
ok(att.windowAt(s, edt('2026-10-06', '07:55')) === null && att.windowAt(s, edt('2026-10-08', '07:55')) !== null && att.windowAt(s, edt('2026-12-10', '07:55')) === null,
  'defaults: Oct 6 skipped, Oct 8 open, Dec 10 after the last day');
ok(att.nextWindow(s, edt('2026-10-01', '07:00')).date === '2026-10-01' && att.upgradeAtt({ title: 'x' }).schedule.close === '08:05', 'defaults: first Thursday is Oct 1; upgrade fills the defaults');
// The window tests below use a plain weekly schedule with no bounds and no holidays.
att.ADMIN.saveSettings(s, { title: 'ECON 101', days: [2, 4], open: '07:50', close: '08:01', start: '', end: '', skip: '' });

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
ok(r === 8000, 'refresh every 8 s during class (window open): ' + r);
ok(att.refreshIn(s, edt('2026-10-06', '09:49')) === 8000 && att.refreshIn(s, edt('2026-10-06', '09:50')) === 30000, 'class lasts 2 hours from the opening; then the 30 s idle rate');
r = att.refreshIn(s, edt('2026-10-06', '07:49') + 40000);
ok(r > 19000 && r < 21000, 'refresh at the open time when it is under 30 s away: ' + r);
ok(att.refreshIn(s, edt('2026-10-06', '11:00')) === 30000, 'idle rate when the next window is days away');
w = att.windowAt(s, edt('2026-10-06', '07:55') + 20000);
ok(w.closesAt === new Date(edt('2026-10-06', '08:01')).toISOString(), 'closesAt is the instant the window closes');

// close now: the weekly window ends at this minute; the day stays in the grid; a later "open now" reopens
throws(() => att.ADMIN.closeNow(s, edt('2026-10-06', '07:40')), /not open/, 'close now refused while closed');
att.ADMIN.closeNow(s, edt('2026-10-06', '07:55') + 30000);
ok(s.cutoff.date === '2026-10-06' && s.cutoff.close === '07:55' && att.windowAt(s, edt('2026-10-06', '07:55') + 31000) === null, 'closed at this minute');
ok(att.windowsOn(s, '2026-10-06', 2)[0].close === '07:55' && att.nextWindow(s, edt('2026-10-06', '07:56')).date === '2026-10-08', 'window shortened; next is Thursday');
ok(att.windowAt(s, edt('2026-10-08', '07:55')) !== null, 'other days unaffected');
att.ADMIN.addExtra(s, '2026-10-06', '07:58', '08:10');
ok(s.cutoff === null && att.windowAt(s, edt('2026-10-06', '08:05')).close === '08:10', 'open now after an early close reopens');
att.ADMIN.closeNow(s, edt('2026-10-06', '07:50') + 5000);
ok(att.windowAt(s, edt('2026-10-06', '07:50') + 6000) === null && att.windowsOn(s, '2026-10-06', 2).length === 2
  && att.windowsOn(s, '2026-10-06', 2)[1].close === '07:58' && att.nextWindow(s, edt('2026-10-06', '07:52')).date === '2026-10-08',
  'closing in the opening minute: zero-length windows, listed for the grid but never next');
s.cutoff = null; s.extra = [];

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

// add and remove one student
att.ADMIN.addStudent(s, 'Ada', 'Aardvark', ' AardvarkA1 ');
ok(s.roster.length === 3 && s.roster[0].email === 'aardvarka1@montclair.edu' && s.roster[0].first === 'Ada', 'student added by login ID, sorted first');
throws(() => att.ADMIN.addStudent(s, 'X', 'Y', 'aardvarka1@mail.montclair.edu'), /on the roster/, 'duplicate (other domain) refused');
throws(() => att.ADMIN.addStudent(s, 'X', 'Y', 'not an email'), /not valid/, 'bad address refused');
att.ADMIN.removeStudent(s, 'AardvarkA1@mail.montclair.edu');
ok(s.roster.length === 2 && !att.student(s, 'aardvarka1@montclair.edu'), 'student removed by either domain');
throws(() => att.ADMIN.removeStudent(s, 'nobody@x.edu'), /not on the roster/, 'removing an unknown student refused');

// in-class questions (the student on the roster is khanj6@montclair.edu; a Tuesday during class)
const t0 = edt('2026-10-06', '08:10');
ok(att.openQuestion(s, t0) === null && att.refreshIn(s, t0) === 8000, 'no question open; 8 s refresh during class');
ok(att.refreshIn(s, edt('2026-10-06', '14:00')) === 30000 && att.refreshIn(s, edt('2026-10-06', '07:49')) === 30000, 'idle refresh outside class');
throws(() => att.ADMIN.askQuestion(s, 'essay', 0, '', '', 2, t0), /question type/, 'unknown kind refused');
throws(() => att.ADMIN.askQuestion(s, 'mc', 6, '', '', 2, t0), /2 to 5/, 'six choices refused');
throws(() => att.ADMIN.askQuestion(s, 'tf', 0, '', 'Yes', 2, t0), /one of True, False/, 'correct answer not among the options refused');
throws(() => att.ADMIN.askQuestion(s, 'yn', 0, '', '', 0, t0), /1 to 600/, 'zero minutes refused');
const q1 = att.ADMIN.askQuestion(s, 'mc', 3, ' Which curve shifts? ', 'b', 2, t0);
ok(s.questions.length === 1 && q1.text === 'Which curve shifts?' && q1.correct === 'B' && att.options(q1).join() === 'A,B,C'
  && q1.closes === new Date(t0 + 120000).toISOString(), 'multiple choice with 3 options, correct label normalized, closes in 2 minutes');
ok(att.openQuestion(s, t0 + 1000) === q1 && att.refreshIn(s, t0 + 1000) === 3000 && att.openQuestion(s, t0 + 120000) === null, 'open until it closes; 3 s refresh while open');
ok(att.checkAnswer(s, q1.id, ' c ', t0 + 5000) === 'C', 'answer label normalized');
throws(() => att.checkAnswer(s, q1.id, 'D', t0 + 5000), /Choose one/, 'answer outside the options refused');
throws(() => att.checkAnswer(s, q1.id, 'A', t0 + 120000), /closed/, 'answer after closing refused');
throws(() => att.checkAnswer(s, 'nope', 'A', t0), /no longer exists/, 'unknown question refused');
v = att.studentView(s, 'khanj6@montclair.edu', null, t0 + 5000, id => (id === q1.id ? { answer: 'C' } : null));
ok(v.question && v.question.open && v.question.answered === 'C' && v.question.correct === '' && v.question.options.length === 3 && v.refreshIn === 3000,
  'student view: open question with own answer, correct answer hidden');
v = att.studentView(s, 'khanj6@montclair.edu', null, t0 + 130000, id => (id === q1.id ? { answer: 'C' } : null));
ok(v.question && !v.question.open && v.question.correct === 'B' && v.question.answered === 'C', 'student view: just closed, correct answer shown');
ok(att.studentView(s, 'khanj6@montclair.edu', null, t0 + 400000, () => null).question === null, 'student view: closed question gone after 3 minutes');
att.ADMIN.extendQuestion(s, q1.id, 1, t0 + 60000);
ok(q1.closes === new Date(t0 + 180000).toISOString(), 'extend adds a minute to the close time');
att.ADMIN.closeQuestion(s, q1.id, t0 + 90000);
ok(q1.closes === new Date(t0 + 90000).toISOString() && att.openQuestion(s, t0 + 90000) === null, 'close now');
att.ADMIN.extendQuestion(s, q1.id, 2, t0 + 300000);
ok(att.openQuestion(s, t0 + 300000) === q1 && q1.closes === new Date(t0 + 420000).toISOString(), 'reopen a closed question for 2 minutes');
const q2 = att.ADMIN.askQuestion(s, 'tf', 0, '', '', 5, t0 + 310000);
ok(att.openQuestion(s, t0 + 310000) === q2 && !att.isQuestionOpen(q1, t0 + 310000) && q2.correct === '' && att.options(q2).join() === 'True,False',
  'asking a new question closes the open one');
att.ADMIN.setCorrect(s, q2.id, 'false');
ok(q2.correct === 'False', 'correct answer set later');
throws(() => att.ADMIN.setCorrect(s, q2.id, 'B'), /one of True, False/, 'bad correct answer refused');
att.ADMIN.deleteQuestion(s, q1.id);
ok(s.questions.length === 1 && att.question(s, q1.id) === null, 'question deleted');
throws(() => att.ADMIN.deleteQuestion(s, q1.id), /no longer exists/, 'deleting twice refused');
ok(att.upgradeAtt({ title: 'x' }).questions.length === 0, 'upgrade adds the questions list');

console.log('passed', pass, 'failed', fail);
process.exit(fail ? 1 : 0);
