// Tests the Worker end to end against a local copy (sign-in check, storage, simultaneous claims).
// It signs its own test tokens and serves the matching public key, so no Google account is involved.
//
//   cd worker
//   npx wrangler d1 execute group-signup --local --file schema.sql
//   npx wrangler dev --port 8791 --var GOOGLE_CLIENT_ID:test-client --var ADMIN_EMAILS:prof@gmail.com --var GOOGLE_CERTS_URL:http://127.0.0.1:8799/certs
//   node ../test/test_worker.mjs        (in a second terminal)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = process.env.API || 'http://127.0.0.1:8791';
// The Worker keeps the public key it fetched for an hour, so the test key is kept between runs.
const keyFile = path.join(os.tmpdir(), 'group_signup_test_key.pem');
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
const KEY = 't' + Date.now();
const PROF = token('Prof@Gmail.com');
const m = i => 's' + i + '@x.edu';
const stu = (i, action, ...args) => post('/', { token: token(m(i)), class: KEY, action: action, args: args });
const adm = (action, args = [], key = KEY) => post('/admin', { token: PROF, class: key, action: action, args: args });

// sign-in checks
let r = await fetch(API + '/config');
ok(r.headers.get('access-control-allow-origin') === '*' && (await r.json()).clientId === 'test-client', 'config is public and readable across origins');
const bad = async (tok, label) => ok((await post('/', { token: tok, class: KEY, action: 'state' })).error === 'SIGNIN', label);
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

// instructor page
ok(/not an instructor/.test((await post('/admin', { token: token(m(1)), class: KEY, action: 'whoami' })).error), 'student cannot use the instructor API');
r = await adm('createClass', [KEY, 'Test class ' + KEY], '');
ok(r.ok && r.data.key === KEY, 'create class');
ok(/exists/.test((await adm('createClass', [KEY, 'again'], '')).error), 'duplicate class key refused');
ok((await (await fetch(API + '/config')).json()).classes.some(c => c.key === KEY && c.title === 'Test class ' + KEY), 'class is listed');
const N = 30;
r = await adm('importRoster', ['first,last,email\n' + Array.from({ length: N }, (_, i) => `F${i},L${i},${m(i)}`).join('\n')]);
ok(r.ok && r.data.state.roster.length === N, 'roster import');
ok((await stu(99, 'state')).state.authorized === false, 'account outside the roster is blocked');
ok(/does not match any class/.test((await post('/', { token: token(m(1)), class: 'nope', action: 'state' })).error), 'unknown class');

// ten students create groups at the same moment: ten distinct groups
const LEADERS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
let out = await Promise.all(LEADERS.map(i => stu(i, 'createGroup')));
let names = out.map(o => o.ok && o.state.me.group);
ok(out.every(o => o.ok) && new Set(names).size === 10, 'simultaneous group creation: ' + names.join(', '));
out = await Promise.all(LEADERS.map(i => stu(i + 10, 'requestJoin', names[i])));
ok(out.every(o => o.ok), 'simultaneous join requests ' + out.map(o => o.error || '').join(''));
out = await Promise.all(LEADERS.map(i => stu(i, 'decideRequest', m(i + 10), true)));
ok(out.every(o => o.ok && o.state.groups.find(g => g.name === names[i0(o)]).members.length === 2), 'simultaneous approvals');
function i0(o) { return names.indexOf(o.state.me.group); }

// ten leaders claim the same topic and the same dataset at the same moment: one winner each
out = await Promise.all(LEADERS.map(i => stu(i, 'claimTopic', 1)));
ok(out.filter(o => o.ok).length === 1 && out.filter(o => /just claimed by/.test(o.error)).length === 9, 'simultaneous topic claim has exactly one winner');
out = await Promise.all(LEADERS.map(i => stu(i, 'claimDataset', 5)));
ok(out.filter(o => o.ok).length === 1 && out.filter(o => /just claimed by/.test(o.error)).length === 9, 'simultaneous dataset claim has exactly one winner');
const st = (await adm('get')).data.state;
ok(st.groups.filter(g => g.topic === '1').length === 1 && st.groups.filter(g => g.dataset === '5').length === 1, 'stored state has one holder each');

// preview and log
r = await post('/', { token: PROF, class: KEY, action: 'requestJoin', args: [names[0]], viewAs: m(25) });
ok(r.ok && r.state.preview && r.state.me.request === names[0], 'instructor acts as a student');
r = await post('/', { token: token(m(26)), class: KEY, action: 'leaveGroup', args: [], viewAs: m(0) });
ok(r.ok && !r.state.preview && (await stu(0, 'state')).state.me.group === names[0], 'student cannot act as another student');
await post('/', { token: token(m(3)), class: KEY, action: 'state', note: 'sign in' });
const rows = (await adm('log', ['', 1000])).data.rows;
const count = a => rows.filter(x => x.action === a).length;
ok(count('claim topic') === 1 && count('refused: claimTopic') === 9 && count('create group') === 10 && count('approve request') === 10,
  'log has one line per action and per refusal');
ok(rows.some(x => x.action === 'sign in' && x.actor === m(3)) && rows.some(x => /preview by prof@gmail.com/.test(x.actor)), 'sign-ins and previews are logged');
ok((await adm('log', ['refused', 1000])).data.rows.length === 18, 'log search');

// instructor edits, then delete
r = await adm('setClaim', [names[2], 'topic', '9']);
ok(r.ok && r.data.state.groups.find(g => g.name === names[2]).topic === '9', 'instructor assigns a topic');

// snapshots and restore
let snaps = (await adm('snapshots', [1000])).data.rows;
ok(snaps.length > 0 && snaps[0].action === 'set claim', 'every change saved a snapshot; newest first: ' + snaps[0].action);
const before = snaps[0];  // state before the instructor's topic change
r = await adm('removeStudent', [m(0)]);
ok(r.ok && !r.data.state.roster.some(x => x.email === m(0)), 'student removed');
r = await adm('restore', [before.id]);
const back = r.data.state;
ok(r.ok && back.roster.some(x => x.email === m(0)) && back.groups.find(g => g.name === names[2]).topic !== '9' && back.version === undefined, 'restore undoes the removal and the topic change');
ok((await (await fetch(API + '/version?c=' + KEY)).json()).version === r.data.version, 'version route matches the write');
snaps = (await adm('snapshots', [1000])).data.rows;
ok(snaps[0].action === 'restore' && snaps[1].action === 'remove student', 'the restore itself is snapshotted: ' + snaps.slice(0, 3).map(x => x.action).join(' | '));
ok(/Type the class key/.test((await adm('deleteClass', ['wrong'])).error), 'delete needs the key typed');
r = await adm('deleteClass', [KEY]);
ok(r.ok && !r.data.classes.some(c => c.key === KEY), 'delete class');
ok(/does not match any class/.test((await adm('get')).error) && (await adm('log', ['', 10])).data.rows.length === 0, 'class and its log are gone');

server.close();
console.log('passed', pass, 'failed', fail);
process.exit(fail ? 1 : 0);
