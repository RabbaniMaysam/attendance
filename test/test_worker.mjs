// Tests the Worker end to end against a local copy (sign-in check, storage, every action of both pages).
// It signs its own test tokens and serves the matching public key, so no Google account is involved.
//
//   cd worker
//   npx wrangler d1 execute attendance --local --file schema.sql
//   npx wrangler dev --port 8791 --var GOOGLE_CLIENT_ID:test-client --var ADMIN_EMAILS:prof@gmail.com --var GOOGLE_CERTS_URL:http://127.0.0.1:8799/certs --var SESSION_SECRET:test-secret
//   node ../test/test_worker.mjs        (in a second terminal)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as attMod from '../worker/src/attendance.js';

const API = process.env.API || 'http://127.0.0.1:8791';
// The Worker keeps the public key it fetched for an hour, so the test key is kept between runs.
const keyFile = path.join(os.tmpdir(), 'attendance_test_key.pem');
if (!fs.existsSync(keyFile)) {
  fs.writeFileSync(keyFile, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
}
const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile));
const publicKey = crypto.createPublicKey(privateKey);
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'test-key', alg: 'RS256', use: 'sig' });
const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise(r => server.listen(8799, '127.0.0.1', r));

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(email, over = {}, key = privateKey) {
  const body = b64({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }) + '.' + b64(Object.assign({
    iss: 'https://accounts.google.com', aud: 'test-client', email: email, email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 600 }, over));
  return body + '.' + crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url');
}

let pass = 0, fail = 0;
const ok = (cond, label) => { cond ? pass++ : (fail++, console.log('FAIL:', label)); };
const post = async (path, body) => (await fetch(API + path, { method: 'POST', body: JSON.stringify(body) })).json();
const PROF = token('Prof@Gmail.com');
const m = i => 's' + i + '@x.edu';
const AK = 'a' + Date.now();
const att = (action, args = [], key = AK) => post('/att/admin', { token: PROF, class: key, action: action, args: args });
const attStu = (i, action, args = []) => post('/att', { token: token(m(i)), class: AK, action: action, args: args });

// sign-in checks
let r = await fetch(API + '/att/config');
const conf = await r.json();
ok(r.headers.get('access-control-allow-origin') === '*' && conf.clientId === 'test-client' && conf.sessions === true, 'config is public and readable across origins');
ok((await post('/', { token: PROF, class: AK, action: 'state' })).error === 'Not found.' && (await (await fetch(API + '/config')).json()).error === 'Not found.', 'the sign-up routes are not served');
const bad = async (tok, label) => ok((await post('/att', { token: tok, class: AK, action: 'state' })).error === 'SIGNIN', label);
await bad('', 'no token');
await bad('a.b.c', 'garbage token');
await bad(token(m(1), {}, other.privateKey), 'token signed by another key');
await bad(token(m(1), { aud: 'someone-else' }), 'token issued for another site');
await bad(token(m(1), { exp: Math.floor(Date.now() / 1000) - 5 }), 'expired token');
await bad(token(m(1), { email_verified: false }), 'unverified email');
await bad(token(m(1), { iss: 'https://evil.example' }), 'wrong issuer');
const forged = token(m(1)).split('.');
forged[1] = b64({ iss: 'https://accounts.google.com', aud: 'test-client', email: 'prof@gmail.com', email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 });
await bad(forged.join('.'), 'payload altered after signing');

// class, roster
ok(/not an instructor/.test((await post('/att/admin', { token: token(m(1)), class: AK, action: 'whoami' })).error), 'attendance admin needs an instructor');
r = await att('createClass', [AK, 'Attendance test'], '');
ok(r.ok && r.data.key === AK && (await (await fetch(API + '/att/config')).json()).classes.some(c => c.key === AK), 'attendance class created and listed');
ok(/exists/.test((await att('createClass', [AK, 'again'], '')).error), 'duplicate class key refused');
r = await att('importRoster', ['first,last,email\nF1,L1,' + m(1) + '\nF2,L2,' + m(2)]);
ok(r.ok && r.data.state.roster.length === 2 && r.data.state.schedule.open === '07:50', 'attendance roster imported, default schedule');
r = await att('previewRoster', ['first,last,email\nF1,L1,' + m(1)]);
ok(r.ok && r.data.file === 1 && r.data.matched === 1 && r.data.added.length === 0 && r.data.missing.map(x => x.email).join() === m(2)
  && (await att('get')).data.state.roster.length === 2, 'roster preview lists the student not in the file and changes nothing');
r = await att('importRoster', ['first,last,email\nF1,L1,' + m(1), [m(2)]]);
ok(r.ok && r.data.state.roster.length === 2, 'import keeps the student the instructor chose to keep');
ok((await attStu(9, 'state')).state.authorized === false, 'account outside the attendance roster is blocked');
ok(!(await attStu(9, 'state')).state.instructor, 'a blocked student is not flagged as an instructor');
r = await post('/att', { token: PROF, class: AK, action: 'state' });
ok(r.state.authorized === false && r.state.instructor === true, 'an instructor account on the student page is flagged for the link to the instructor page');
ok(/does not match any class/.test((await post('/att', { token: token(m(1)), class: 'nope', action: 'state' })).error), 'unknown class');

// session tokens: issued after a Google sign-in, accepted afterwards, forgeries refused
r = await attStu(1, 'state');
const sess = r.session;
ok(r.ok && typeof sess === 'string' && /^s1\.[\w-]+\.[\w-]+$/.test(sess), 'a Google sign-in answer carries a session token');
r = await post('/att', { token: sess, class: AK, action: 'state' });
ok(r.ok && r.state.authorized === true && !('session' in r), 'the session token signs the student in (and is not reissued)');
const sp = sess.split('.');
const sPayload = JSON.parse(Buffer.from(sp[1], 'base64url').toString());
ok(sPayload.e === m(1) && sPayload.x > Date.now() + 170 * 86400000 && sPayload.x < Date.now() + 190 * 86400000, 'the session token names the account and lasts about 180 days');
await bad('s1.' + Buffer.from(JSON.stringify({ e: 'prof@gmail.com', x: sPayload.x })).toString('base64url') + '.' + sp[2], 'session token with an altered account');
await bad('s1.' + Buffer.from(JSON.stringify({ e: m(1), x: Date.now() - 1000 })).toString('base64url') + '.' + sp[2], 'expired session token');
await bad(sp[0] + '.' + sp[1] + '.' + sp[2].slice(0, -2) + 'AA', 'session token with a bad signature');
ok(/not an instructor/.test((await post('/att/admin', { token: sess, class: AK, action: 'whoami' })).error), 'a student session cannot use the instructor API');
r = await att('whoami');
ok(r.ok && r.session && (await post('/att/admin', { token: r.session, class: AK, action: 'whoami' })).ok, 'the instructor gets a session token that works on the instructor API');

// Closed: no day is scheduled, so the mark is refused.
await att('saveSettings', [{ title: 'Attendance test', days: [], open: '07:50', close: '08:01', skip: '' }]);
r = await attStu(1, 'state');
ok(r.ok && r.state.authorized && r.state.open === null && r.state.next === null, 'closed with nothing scheduled');
ok(/not open/.test((await attStu(1, 'mark')).error), 'mark refused while closed');
// Open now for 5 minutes, then the student marks with the session code (the current code, computed from the
// secret and the server clock as the instructor page does); a second press changes nothing.
r = await att('openNow', [5]);
ok(r.ok && r.data.open && r.data.state.extra.length === 1 && /^[0-9a-f]{32}$/.test(r.data.secret) && r.data.state.secret === undefined && r.data.now,
  'open now adds a window, reports open with the secret and the clock (the secret is not in the state)');
const code = () => attMod.sessionCode({ secret: r.data.secret }, attMod.codeSlot(Date.now(), r.data.state));
ok(r.data.state.codeSec === 6, 'the code interval is 6 seconds by default');
ok(/Wrong session code/.test((await attStu(1, 'mark', [attMod.sessionCode({ secret: r.data.secret }, attMod.codeSlot(Date.now(), r.data.state) + 2)])).error) && /Wrong session code/.test((await attStu(1, 'mark')).error), 'wrong or missing code refused');
ok((await attStu(1, 'state')).state.needCode === true && (await attStu(1, 'state')).state.codeSec === 6, 'the student page is told a code is needed and its interval');
// A 20-second interval: the Worker and the page's copy of the hash agree on the slot, and the 6-second code is refused.
r = await att('saveSettings', [{ title: 'Attendance test', days: [], open: '07:50', close: '08:01', skip: '', codeSec: '20' }]);
ok(r.ok && r.data.state.codeSec === 20 && (await attStu(1, 'state')).state.codeSec === 20, 'interval saved as 20 seconds');
ok(/every 20 seconds/.test((await attStu(1, 'mark', [attMod.sessionCode({ secret: r.data.secret }, Math.floor(Date.now() / 6000))])).error), 'the 6-second code is refused with the interval in the message');
ok(/from 3 to 300/.test((await att('saveSettings', [{ title: 'Attendance test', days: [], open: '07:50', close: '08:01', skip: '', codeSec: '1' }])).error), 'a 1-second interval is refused');
r = await att('saveSettings', [{ title: 'Attendance test', days: [], open: '07:50', close: '08:01', skip: '', codeSec: '6' }]);
ok(r.ok && r.data.state.codeSec === 6, 'back to 6 seconds');
let rs = await attStu(1, 'mark', [code()]);
ok(rs.ok && rs.state.marked && rs.state.open, 'student marked present with the code');
const firstMark = rs.state.marked;
rs = await attStu(1, 'mark', [code()]);
ok(rs.ok && rs.state.marked === firstMark, 'second press keeps the first time');
// Extend the open round by 10 minutes.
r = await att('get');
const closeBefore = r.data.open.close;
r = await att('extendNow', [10]);
ok(r.ok && r.data.open && r.data.open.close > closeBefore && r.data.state.extended[r.data.open.id] === r.data.open.close, 'extended by 10 minutes: closes later');
ok(/1 to 600/.test((await att('extendNow', [0])).error), 'extend by zero refused');
r = await att('get');
const round1 = r.data.open.id;
ok(r.data.marks.length === 1 && r.data.marks[0].email === m(1) && r.data.marks[0].round === round1 && r.data.marks[0].self === firstMark
  && r.data.marks[0].present === 1 && r.data.marks[0].edited === null && r.data.rounds.some(x => x.id === round1), 'instructor sees the mark and the open round');
ok(r.data.open.closesAt && Date.parse(r.data.open.closesAt) - Date.now() > 3 * 60000, 'the open window reports its closing instant');
ok(/Attendance is open/.test((await att('setMark', [round1, m(2), true])).error), 'cells cannot be changed while a round is open');
r = await att('closeNow', []);
ok(r.ok && r.data.open === null && r.data.state.closed[round1] && (await attStu(2, 'state')).state.open === null && /not open/.test((await attStu(2, 'mark', [code()])).error), 'closed early');
ok(/not open/.test((await att('closeNow', [])).error) && /not open/.test((await att('extendNow', [5])).error), 'close now and extend refused when closed');
// Changes after the fact. Setting a student's own mark absent keeps the row, so the manual change (-1) is on record; setting it present again is change 0.
r = await att('setMark', [round1, m(2), true]);
let mk = r.data.marks.find(x => x.email === m(2));
ok(r.data.marks.length === 2 && mk.present === 1 && mk.self === null && mk.edited && mk.by === 'prof@gmail.com', 'instructor marks a student (change +1)');
r = await att('setMark', [round1, m(2), false]);
ok(r.data.marks.length === 1, 'instructor clears a mark the student never made: no row is left');
r = await att('setMark', [round1, m(1), false]);
mk = r.data.marks.find(x => x.email === m(1));
ok(r.data.marks.length === 1 && mk.present === 0 && mk.self === firstMark && mk.edited && mk.by === 'prof@gmail.com', 'instructor sets a marked student absent (change -1)');
r = await attStu(1, 'state');
ok(r.state.marked === '' && r.state.today.length === 0, 'the student is no longer marked');
r = await att('setMark', [round1, m(1), true]);
mk = r.data.marks.find(x => x.email === m(1));
ok(mk.present === 1 && mk.self === firstMark, 'set present again: the student\'s own time is kept (change 0)');
ok((await attStu(1, 'state')).state.today.length === 1, 'the student is marked again');
// A batch of changes is one action; a bad row refuses the whole batch.
r = await att('setMarks', [[[round1, m(1), false], ['2026-01-05 10:00', m(2), true]]]);
ok(r.ok && r.data.marks.length === 2 && r.data.marks.find(x => x.email === m(1)).present === 0 && r.data.rounds[0].id === '2026-01-05 10:00' && r.data.rounds[0].close === '',
  'setMarks saves two changes; a mark in a past round lists that round');
ok(/round and an email/.test((await att('setMarks', [[[round1, m(1), true], ['2026-01-05', m(2), true]]])).error) && (await att('get')).data.marks.find(x => x.email === m(1)).present === 0,
  'a date alone is not a round: the batch is refused whole');
ok(/No change/.test((await att('setMarks', [[]])).error), 'an empty batch is refused');
// The report: 2 roster students, rounds that have opened (round1 and the past one); points off by default.
r = await att('get');
ok(r.data.report && r.data.report.perSession === 0 && r.data.report.students[m(2)].present === 1 && r.data.report.students[m(1)].present === 0
  && r.data.report.dates.indexOf('2026-01-05') !== -1, 'report lists students and sessions');
r = await att('saveSettings', [{ title: 'Attendance test', days: [], open: '07:50', close: '08:01', skip: '', pointsMode: 'per', points: '0.5' }]);
ok(r.ok && r.data.state.points.value === 0.5 && r.data.report.perSession === 0.5 && Math.abs(r.data.report.students[m(2)].points - 0.5) < 1e-9, 'points per session set and reported');
// Excluding a date: the round stays in the grid, but the report leaves it out; including it puts it back.
r = await att('excludeDate', ['2026-01-05']);
ok(r.ok && r.data.state.exclude.join() === '2026-01-05' && r.data.rounds.some(x => x.id === '2026-01-05 10:00') && r.data.report.dates.indexOf('2026-01-05') === -1
  && r.data.report.students[m(2)].present === 0 && r.data.report.students[m(2)].rounds === 1, 'excluded date: round listed, left out of the report');
ok(/not excluded/.test((await att('includeDate', ['2026-01-06'])).error), 'including a date that counts is refused');
r = await att('includeDate', ['2026-01-05']);
ok(r.ok && r.data.state.exclude.length === 0 && r.data.report.students[m(2)].present === 1, 'included again');
// Codes off: a press without a code is accepted. Within the same minute "open now" reopens the same round (a round is identified by its opening minute).
r = await att('saveSettings', [{ title: 'Attendance test', days: [], open: '07:50', close: '08:01', skip: '', code: false }]);
ok(r.ok && r.data.state.code === false && (await attStu(1, 'state')).state.needCode === false, 'session codes switched off');
r = await att('openNow', [5]);
ok(r.ok && r.data.open && r.data.open.id === round1 && !r.data.state.closed[round1], 'open now after an early close in the same minute reopens the round');
r = await attStu(1, 'mark');
ok(r.state.marked === firstMark && r.state.today.length === 1, 'a press (no code needed) while the round is open makes the student present again, first time kept');
r = await att('closeNow', []);
// Full download and the backup note.
r = await att('export');
ok(r.ok && r.data.state.roster.length === 2 && r.data.state.secret === undefined && r.data.marks.length === 2 && Array.isArray(r.data.answers) && r.data.log.length > 5 && r.data.log[0].action === 'create class',
  'export has the state (no secret), the marks, the answers, and the whole log oldest first');
r = await att('noteBackup', ['downloaded']);
ok(r.ok && r.data.state.backupAt && Date.now() - Date.parse(r.data.state.backupAt) < 60000, 'backup noted with the time');
// Named backups: save, list, download, restore (the replaced data saved first), delete.
const secret0 = r.data.secret, backupAt0 = r.data.state.backupAt;
r = await att('backup', ['  After   Mid 1 ']);
ok(r.ok && r.data.backups.length === 1 && r.data.backups[0].name === 'After Mid 1' && r.data.backups[0].by === 'prof@gmail.com'
  && r.data.backups[0].info.marks === 2 && r.data.backups[0].info.roster === 2 && r.data.backups[0].info.rounds === 2, 'named backup saved and listed with its counts');
const marks0 = r.data.marks;
const mid1 = r.data.backups[0].id;
ok(/the limit is 100/.test((await att('backup', ['x'.repeat(101)])).error) && (await att('get')).data.backups.length === 1, 'a name over 100 characters is refused');
r = await att('backup', ['']);
ok(r.ok && r.data.backups.length === 2 && r.data.backups[0].name === '' && r.data.backups[0].id > mid1, 'an unnamed backup is saved, newest first');
await att('deleteBackup', [r.data.backups[0].id]);
r = await att('getBackup', [mid1]);
ok(r.ok && r.data.name === 'After Mid 1' && r.data.key === AK && r.data.state.secret === undefined && r.data.marks.length === 2 && r.data.state.roster.length === 2, 'backup downloaded (no secret)');
await att('setMarks', [marks0.map(x => [x.round, x.email, false])]);
await att('removeStudent', [m(2)]);
r = await att('get');
ok(r.data.marks.filter(x => x.present).length === 0 && r.data.state.roster.length === 1, 'class changed after the backup');
r = await att('restoreBackup', [mid1]);
ok(r.ok && r.data.marks.length === 2 && r.data.marks.every(x => x.present === 1) && r.data.state.roster.length === 2 && r.data.secret === secret0 && r.data.state.backupAt === backupAt0,
  'restore returns marks and roster; the session-code secret and the download note stay');
ok(r.data.backups.length === 2 && r.data.backups[0].name === 'Before restoring After Mid 1' && r.data.backups[0].info.roster === 1, 'the replaced data are saved first as a backup');
const undo = r.data.backups[0].id;
r = await att('restoreBackup', [undo]);
ok(r.ok && r.data.state.roster.length === 1 && r.data.marks.filter(x => x.present).length === 0 && r.data.backups.length === 3, 'a restore can be undone');
r = await att('restoreBackup', [mid1]);
ok(r.ok && r.data.state.roster.length === 2 && r.data.marks.length === 2, 'restored again');
r = await att('deleteBackup', [mid1]);
ok(r.ok && !r.data.backups.some(b => b.id === mid1) && /does not exist/.test((await att('getBackup', [mid1])).error)
  && /does not exist/.test((await att('restoreBackup', [mid1])).error), 'backup deleted');
r = await att('removeExtra', [round1.slice(0, 10), round1.slice(11)]);
ok(r.data.open === null && (await attStu(2, 'state')).state.open === null, 'window removed: closed again');
ok(r.data.marks.length === 2 && r.data.rounds.some(x => x.id === round1), 'the marks made in the open-now round are kept after the window is removed');
r = await att('importRoster', ['Student,SIS Login ID\n"    Points Possible",\n"Student, Test",843b2ebf97d6dff55e1ba2ce8c7910f987d72b05\n"Doe, Jane",doej1']);
ok(r.ok && r.data.state.roster.length === 1 && r.data.state.roster[0].email === 'doej1@montclair.edu' && r.data.state.roster[0].first === 'Jane', 'Canvas roster imported');
ok((await post('/att', { token: token('doej1@mail.montclair.edu'), class: AK, action: 'state' })).state.authorized === true, 'mail.montclair.edu sign-in matches the montclair.edu roster');
r = await att('addStudent', ['Al', 'Ash', 'asha1']);
ok(r.ok && r.data.state.roster.length === 2 && r.data.state.roster[0].email === 'asha1@montclair.edu', 'student added by login ID');
r = await att('removeStudent', ['asha1@mail.montclair.edu']);
ok(r.ok && r.data.state.roster.length === 1, 'student removed');
await att('addStudent', ['Bo', 'Bash', 'bashb1']);
await att('addStudent', ['Cy', 'Cash', 'cashc1']);
ok(/nobody@x.edu is not on the roster/.test((await att('removeStudents', [['bashb1@montclair.edu', 'nobody@x.edu']])).error) && (await att('get')).data.state.roster.length === 3, 'bulk removal with an unknown student refused and changes nothing');
r = await att('removeStudents', [['bashb1@mail.montclair.edu', 'cashc1@montclair.edu']]);
ok(r.ok && r.data.state.roster.length === 1 && r.data.state.roster[0].email === 'doej1@montclair.edu', 'two students removed at once');
ok(/^2 students: Bo Bash \(bashb1@montclair.edu\), Cy Cash/.test((await att('log', ['remove students', 'all', 5])).data.rows[0].detail), 'one log line names the removed students');
// in-class questions
await att('importRoster', ['first,last,email\nF1,L1,' + m(1) + '\nF2,L2,' + m(2)]);
// Editing a student: the name, the main address (marks follow it), other addresses that sign the student in.
r = await att('get');
const n1 = r.data.marks.filter(x => x.email === m(1)).length;
r = await att('editStudent', [m(1), 'F1', 'L1-edited', 'n1@x.edu', 'g1@gmail.com, G1@gmail.com']);
ok(r.ok && n1 > 0 && r.data.state.roster.find(x => x.email === 'n1@x.edu').last === 'L1-edited' && r.data.state.roster.find(x => x.email === 'n1@x.edu').alt.join() === 'g1@gmail.com'
  && r.data.marks.filter(x => x.email === 'n1@x.edu').length === n1 && !r.data.marks.some(x => x.email === m(1)), 'student edited: name, address, other address; the marks moved to the new address');
r = await post('/att', { token: token('G1@gmail.com'), class: AK, action: 'state' });
ok(r.ok && r.state.authorized === true && r.state.email === 'n1@x.edu' && r.state.name === 'F1 L1-edited', 'a sign-in with the other address is the same student');
ok(/belongs to F1 L1-edited/.test((await att('editStudent', [m(2), 'F2', 'L2', m(2), 'g1@gmail.com'])).error), 'an address in use by another student is refused');
r = await att('editStudent', ['g1@gmail.com', 'F1', 'L1', m(1), '']);
ok(r.ok && r.data.state.roster.find(x => x.email === m(1)) && !r.data.state.roster.find(x => x.email === m(1)).alt && r.data.marks.filter(x => x.email === m(1)).length === n1
  && (await post('/att', { token: token('g1@gmail.com'), class: AK, action: 'state' })).state.authorized === false, 'edited back by the other address; the marks moved back, the other address no longer signs in');
r = await attStu(1, 'state');
ok(r.ok && r.state.question === null, 'no question in the lobby');
r = await att('askQuestion', ['mc', 4, 'Which curve?', 'C', 2]);
const qid = r.ok && r.data.question && r.data.question.id;
ok(qid && r.data.state.questions.length === 1 && r.data.question.correct === 'C', 'question asked and reported open');
r = await attStu(1, 'state');
ok(r.ok && r.state.question && r.state.question.open && r.state.question.options.join() === 'A,B,C,D' && r.state.question.correct === '' && r.state.refreshIn === 3000,
  'student sees the open question without the correct answer');
r = await attStu(1, 'answer', [qid, 'b']);
ok(r.ok && r.state.question.answered === 'B', 'student answered B');
r = await attStu(1, 'answer', [qid, 'C']);
ok(r.ok && r.state.question.answered === 'C', 'student changed the answer to C');
ok(/Choose one/.test((await attStu(1, 'answer', [qid, 'E'])).error), 'answer outside the options refused');
ok(/not on the class roster/.test((await attStu(9, 'answer', [qid, 'A'])).error), 'answer from outside the roster refused');
r = await attStu(2, 'answer', [qid, 'A']);
r = await att('get');
ok(r.data.answers.length === 2 && r.data.answers.find(a => a.email === m(1)).answer === 'C' && r.data.answers.find(a => a.email === m(2)).answer === 'A', 'instructor sees both answers');
r = await att('closeQuestion', [qid]);
ok(r.ok && r.data.question === null, 'question closed');
ok(/closed/.test((await attStu(2, 'answer', [qid, 'B'])).error), 'answer after closing refused');
r = await attStu(1, 'state');
ok(r.ok && r.state.question && !r.state.question.open && r.state.question.correct === 'C' && r.state.question.answered === 'C', 'student sees the result after closing');
r = await att('extendQuestion', [qid, 1]);
ok(r.ok && r.data.question && r.data.question.id === qid, 'question reopened');
r = await att('askQuestion', ['tf', 0, '', '', 1]);
ok(r.ok && r.data.state.questions.length === 2 && r.data.question.kind === 'tf' && Date.parse(r.data.state.questions[0].closes) <= Date.now(), 'second question closes the first');
ok(/one of True, False/.test((await att('askQuestion', ['tf', 0, '', 'A', 1])).error), 'bad correct answer refused');
r = await att('deleteQuestion', [qid]);
ok(r.ok && r.data.state.questions.length === 1 && r.data.answers.length === 0, 'first question and its answers deleted');
// an open-answer question: typed text, stored verbatim (trimmed), judged against a text correct answer
r = await att('askQuestion', ['open', 0, 'Elasticity?', '1500', 1]);
const oid = r.ok && r.data.question && r.data.question.id;
ok(oid && r.data.question.kind === 'open' && r.data.question.correct === '1500', 'open question asked');
r = await attStu(1, 'answer', [oid, '  1,500.0 ']);
ok(r.ok && r.state.question.answered === '1,500.0' && r.state.question.options.length === 0, 'typed answer stored trimmed');
ok(/Type an answer/.test((await attStu(2, 'answer', [oid, '  '])).error), 'empty typed answer refused');
r = await attStu(2, 'answer', [oid, 'about 1500, I think']);
ok(r.ok && r.state.question.answered === 'about 1500, I think', 'free text stored');
r = await att('closeQuestion', [oid]);
r = await attStu(1, 'state');
ok(r.ok && !r.state.question.open && r.state.question.correct === '1500' && r.state.question.right === true, 'numeric answer judged right after closing');
r = await attStu(2, 'state');
ok(r.ok && r.state.question.right === false, 'free text judged wrong');
r = await att('deleteQuestion', [oid]);
ok(r.ok && r.data.answers.length === 0, 'open question and its answers deleted');
// Removing a round deletes its marks. A scheduled round is listed as removed (no window that day) until restored.
r = await att('get');
const nMarks = r.data.marks.length;
ok(r.data.marks.some(x => x.round === '2026-01-05 10:00') && r.data.rounds.some(x => x.id === '2026-01-05 10:00'), 'the past round with a mark is listed');
r = await att('removeRound', ['2026-01-05 10:00']);
ok(r.ok && r.data.marks.length === nMarks - 1 && !r.data.marks.some(x => x.round === '2026-01-05 10:00') && !r.data.rounds.some(x => x.id === '2026-01-05 10:00') && r.data.state.removed.length === 0,
  'round removed: its mark is deleted and the column is gone');
ok(/not a round/.test((await att('removeRound', ['2026-01-05'])).error), 'a date alone is not a round');
await att('saveSettings', [{ title: 'Attendance test', days: [0, 1, 2, 3, 4, 5, 6], open: '00:00', close: '00:01', skip: '', code: false }]);
r = await att('get');
const todayRound = r.data.today + ' 00:00';
ok(r.data.rounds.some(x => x.id === todayRound), 'a scheduled round at midnight has opened today');
r = await att('removeRound', [todayRound]);
ok(r.ok && r.data.state.removed.join() === todayRound && !r.data.rounds.some(x => x.id === todayRound), 'the scheduled round is removed and listed as removed');
r = await att('restoreRound', [todayRound]);
ok(r.ok && r.data.state.removed.length === 0 && r.data.rounds.some(x => x.id === todayRound), 'restored');
ok(/not removed/.test((await att('restoreRound', [todayRound])).error), 'restoring it again is refused');
await att('saveSettings', [{ title: 'Attendance test', days: [], open: '07:50', close: '08:01', skip: '', code: false }]);
// A large class: the copy is stored in several parts and restored in several inserts.
const BK = AK + '-big';
await att('createClass', [BK, 'Backup size test'], '');
for (const day of ['2026-02-02', '2026-02-03']) {
  await att('setMarks', [Array.from({ length: 1600 }, (_, i) => [day + ' 10:00', 'student-with-a-long-address-' + i + '@example.edu', true])], BK);
}
r = await att('backup', ['big'], BK);
const bigId = r.data.backups[0].id;
ok(r.ok && r.data.backups[0].info.marks === 3200 && (await att('getBackup', [bigId], BK)).data.marks.length === 3200, 'a backup of 3200 marks saved in parts and read back whole');
await att('setMarks', [Array.from({ length: 1600 }, (_, i) => ['2026-02-02 10:00', 'student-with-a-long-address-' + i + '@example.edu', false])], BK);
r = await att('restoreBackup', [bigId], BK);
ok(r.ok && r.data.marks.length === 3200 && r.data.marks.every(x => x.present === 1 && x.by === 'prof@gmail.com'), 'a backup of 3200 marks restored');
ok((await att('deleteInfo', [], BK)).data.backups === 2 && (await att('deleteClass', [BK], BK)).ok && (await att('get')).data.backups.length > 0, 'the backups of a deleted class go with it; other classes keep theirs');
await att('openNow', [5]);
ok(/Restore a backup after it closes/.test((await att('restoreBackup', [(await att('get')).data.backups[0].id])).error), 'no restore while attendance is open');
await att('closeNow', []);
// The log: student marks, answers, and refusals; every instructor change and refusal; filter by who.
let lg = (await att('log', ['', 'all', 5000])).data.rows;
const acts = lg.map(x => x.action);
ok(acts.indexOf('create class') !== -1 && acts.indexOf('open now') !== -1 && acts.indexOf('close now') !== -1 && acts.indexOf('set absent') !== -1 && acts.indexOf('set present') !== -1
  && acts.indexOf('import roster') !== -1 && acts.indexOf('add student') !== -1 && acts.indexOf('remove student') !== -1 && acts.indexOf('save settings') !== -1
  && acts.indexOf('ask question') !== -1 && acts.indexOf('delete question') !== -1 && acts.indexOf('remove extra') !== -1
  && acts.indexOf('extend') !== -1 && acts.indexOf('exclude date') !== -1 && acts.indexOf('include date') !== -1 && acts.indexOf('note backup') !== -1 && acts.indexOf('export') === -1
  && acts.indexOf('backup') !== -1 && acts.indexOf('restore backup') !== -1 && acts.indexOf('delete backup') !== -1 && acts.indexOf('get backup') === -1
  && lg.some(x => x.action === 'remove round' && /1 marks deleted$/.test(x.detail)) && lg.some(x => x.action === 'remove round' && /scheduled window removed/.test(x.detail)) && acts.indexOf('restore round') !== -1,
  'instructor actions logged (reads are not): ' + acts.filter((a, i) => acts.indexOf(a) === i).join(', '));
ok(acts.indexOf('present') !== -1 && acts.indexOf('answer') !== -1 && acts.indexOf('refused: mark') !== -1 && acts.indexOf('refused: setMark') !== -1, 'student marks, answers, and refusals logged');
ok(lg.some(x => x.action === 'sign in' && x.actor === m(1)) && lg.some(x => x.action === 'refused: state' && x.actor === m(9) && /not on the class roster/.test(x.detail)),
  'Google sign-ins on the student page and page loads by accounts outside the roster are logged');
ok(lg.filter(x => x.action === 'present').length === 2 && lg.every(x => x.action !== 'state'), 'a mark is logged once per press that changes something; page loads are not logged');
ok(lg.some(x => x.action === 'set absent' && x.detail.indexOf('F1 L1 (' + m(1) + '), round ' + round1) === 0) && lg.some(x => x.action === 'add student' && x.detail.indexOf('Al Ash (asha1@montclair.edu)') === 0), 'details name the student and the round');
ok((await att('log', ['', 'instructor', 5000])).data.rows.every(x => /\(instructor\)$/.test(x.actor)) && (await att('log', ['', 'students', 5000])).data.rows.every(x => !/\(instructor\)/.test(x.actor))
  && (await att('log', ['', 'students', 5000])).data.rows.length + (await att('log', ['', 'instructor', 5000])).data.rows.length === lg.length, 'log filtered by who');
ok((await att('log', ['set absent', 'all', 5000])).data.rows.every(x => x.action === 'set absent'), 'log search');
r = await att('deleteInfo');
ok(r.ok && r.data.state === undefined && r.data.roster === 2 && ['marks', 'rounds', 'questions', 'answers'].every(k => typeof r.data[k] === 'number') && r.data.log === lg.length && r.data.backups === 3 && typeof r.data.title === 'string',
  'deleteInfo counts: ' + JSON.stringify(r.data));
ok(/Type the class key/.test((await att('deleteClass', ['wrong'])).error), 'attendance delete needs the key typed');
r = await att('deleteClass', [AK]);
ok(r.ok && !r.data.classes.some(c => c.key === AK) && /does not match/.test((await att('get')).error), 'attendance class deleted');
ok((await att('log', ['', 'all', 10])).data.rows.length === 0, 'the attendance log is deleted with the class');

server.close();
console.log('passed', pass, 'failed', fail);
process.exit(fail ? 1 : 0);
