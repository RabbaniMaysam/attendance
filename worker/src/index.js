/**
 * Attendance tool: backend (Cloudflare Worker + D1).
 * The pages in docs/ (GitHub Pages) call it. See README.md.
 *
 *   GET  /att/config  -> {clientId, classes, sessions}     public, needed before sign-in
 *   POST /att         -> student page: {token, class, action: 'state' | 'mark' | 'answer', args: [qid, answer]}   -> {ok, state}
 *   POST /att/admin   -> instructor page: {token, class, action, args}                                         -> {ok, data}
 *
 * Settings, roster, and questions are one JSON row per class (att_classes); marks are rows of
 * att_marks and answers rows of att_answers. The paths and the 'att:' prefix of the log's class
 * column are those of the group sign-up tool, where this tool lived until 2026-10-05.
 */

import { canonEmail } from './roster.js';
import * as att from './attendance.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const json = o => new Response(JSON.stringify(o), {
  headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS)
});

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (request.method === 'GET' && path === '/att/config') {
        // "sessions" says whether the SESSION_SECRET secret is set (without it every sign-in lasts one hour).
        return json({ clientId: env.GOOGLE_CLIENT_ID || '', classes: await attClassList(env), sessions: !!env.SESSION_SECRET });
      }
      if (request.method === 'POST' && (path === '/att' || path === '/att/admin')) {
        const body = await request.text();
        if (body.length > 1000000) throw new Error('The request is too large.');
        const req = JSON.parse(body);
        const who = await verify(req.token, env);
        const real = who.email;
        const args = Array.isArray(req.args) ? req.args.slice(0, 8) : [];
        const key = String(req.class || '');
        const action = String(req.action);
        // After a Google sign-in the answer carries a session token of this tool, which the page keeps
        // for the following visits (Google's own token lasts an hour and the page cannot renew it silently).
        const session = who.google ? await sessionToken(real, env) : '';
        let out;
        if (path === '/att/admin') {
          if (!isAdmin(real, env)) throw new Error('The account ' + real + ' is not an instructor account.');
          out = { ok: true, data: await attAdminCall(env, real, action, key, args) };
        } else out = { ok: true, state: await attStudentCall(env, real, action, key, args) };
        if (session) out.session = session;
        return json(out);
      }
      return json({ ok: false, error: 'Not found.' });
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) });
    }
  }
};

// ---------------------------------------------------------------- sign-in

let certs = null, certsAt = 0;

async function googleKeys(env, refresh) {
  const age = Date.now() - certsAt;
  if (!certs || age > 3600000 || (refresh && age > 60000)) {
    const r = await fetch(env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs');
    if (!r.ok) throw new Error('SIGNIN');
    certs = (await r.json()).keys;
    certsAt = Date.now();
  }
  return certs;
}

const bytes = b64url => Uint8Array.from(atob(b64url.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
const parse = b64url => JSON.parse(new TextDecoder().decode(bytes(b64url)));

/**
 * Returns {email, google} for a sign-in token: either a session token of this tool (see
 * sessionToken) or a Google sign-in token, whose Google signature, client ID (this tool's),
 * and expiry are checked. The error text SIGNIN instructs the page to show the sign-in button again.
 */
async function verify(token, env) {
  try {
    const parts = String(token || '').split('.');
    if (parts[0] === 's1') return { email: await verifySession(parts, env), google: false };
    if (parts.length !== 3 || !env.GOOGLE_CLIENT_ID) throw 0;
    const head = parse(parts[0]), p = parse(parts[1]);
    if (head.alg !== 'RS256') throw 0;
    let jwk = (await googleKeys(env, false)).find(k => k.kid === head.kid);
    if (!jwk) jwk = (await googleKeys(env, true)).find(k => k.kid === head.kid);
    if (!jwk) throw 0;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signed = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes(parts[2]),
      new TextEncoder().encode(parts[0] + '.' + parts[1]));
    const issuer = p.iss === 'accounts.google.com' || p.iss === 'https://accounts.google.com';
    const verified = p.email_verified === true || p.email_verified === 'true';
    if (!signed || !issuer || p.aud !== env.GOOGLE_CLIENT_ID || !verified || !(Number(p.exp) * 1000 > Date.now())) throw 0;
    const email = canonEmail(p.email);
    if (!email) throw 0;
    return { email: email, google: true };
  } catch (e) {
    throw new Error('SIGNIN');
  }
}

/**
 * Session tokens: 's1.' + base64url({e: email, x: expiry ms}) + '.' + base64url(HMAC-SHA256 of that
 * payload with the SESSION_SECRET secret). Issued after a Google sign-in, valid SESSION_DAYS days,
 * kept by the page in the browser's storage, so a student signs in with Google once a semester and
 * the instructor stays signed in on their own computer. Without the secret no token is issued.
 * Signing out deletes the token from the browser; the token cannot be revoked server-side
 * (change the secret to invalidate every session).
 */
const SESSION_DAYS = 180;
const toB64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sessionKey(env) {
  if (!env.SESSION_SECRET) return null;
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sessionToken(email, env) {
  const key = await sessionKey(env);
  if (!key) return '';
  const payload = toB64url(new TextEncoder().encode(JSON.stringify({ e: email, x: Date.now() + SESSION_DAYS * 86400000 })));
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return 's1.' + payload + '.' + toB64url(sig);
}

async function verifySession(parts, env) {
  const key = await sessionKey(env);
  if (!key || parts.length !== 3) throw 0;
  const good = await crypto.subtle.verify('HMAC', key, bytes(parts[2]), new TextEncoder().encode(parts[1]));
  const p = parse(parts[1]);
  const email = canonEmail(p.e);
  if (!good || !email || !(Number(p.x) > Date.now())) throw 0;
  return email;
}

/** Instructors are the emails in the ADMIN_EMAILS secret. */
function isAdmin(email, env) {
  return !!email && String(env.ADMIN_EMAILS || '').toLowerCase().split(/[,;\s]+/).indexOf(email) !== -1;
}

// ---------------------------------------------------------------- storage

const LOG_SQL = 'INSERT INTO log (time, class, actor, action, detail) ';

async function attClassList(env) {
  const out = await env.DB.prepare("SELECT key, json_extract(state, '$.title') AS title FROM att_classes ORDER BY key").all();
  return out.results;
}

async function readAtt(env, key) {
  const row = await env.DB.prepare('SELECT state FROM att_classes WHERE key = ?').bind(key).first();
  if (!row) throw new Error('This link does not match any class.');
  const s = att.upgradeAtt(JSON.parse(row.state));
  if (!s.secret) { s.secret = att.randomSecret(); await writeAtt(env, key, s); }  // a class created before session codes
  return s;
}

function writeAtt(env, key, s) {
  return env.DB.prepare('UPDATE att_classes SET state = ? WHERE key = ?').bind(JSON.stringify(s), key).run();
}

// The log's class column is 'att:' + the class key (kept from the time the log was shared with the sign-up tool).
const attLog = (env, key, actor, action, detail) => env.DB.prepare(LOG_SQL + 'VALUES (?, ?, ?, ?, ?)')
  .bind(new Date().toISOString(), 'att:' + key, actor, action, String(detail || '').slice(0, 2000)).run();

// ---------------------------------------------------------------- student page

async function attStudentCall(env, real, action, key, args) {
  const s = await readAtt(env, key);
  const now = Date.now();
  const date = att.nyParts(now).date;
  try {
    if (action === 'mark') {
      if (!att.student(s, real)) throw new Error('This account is not on the class roster.');
      const open = att.windowAt(s, now);
      if (!open) throw new Error('Attendance is not open right now.');
      att.checkCode(s, args[0], now);
      // The first press sets self; a later press (also after the instructor set the student absent) makes the round present again.
      const res = await env.DB.prepare('INSERT INTO att_marks (class, round, email, self, present) VALUES (?, ?, ?, ?, 1) '
        + 'ON CONFLICT (class, round, email) DO UPDATE SET self = COALESCE(self, excluded.self), present = 1 WHERE present = 0')
        .bind(key, open.id, real, new Date(now).toISOString()).run();
      if (res.meta.changes) await attLog(env, key, real, 'present', 'round ' + open.id);
    } else if (action === 'answer') {
      if (!att.student(s, real)) throw new Error('This account is not on the class roster.');
      const label = att.checkAnswer(s, args[0], args[1], now);
      await env.DB.prepare('INSERT OR REPLACE INTO att_answers (class, qid, email, answer, time) VALUES (?, ?, ?, ?, ?)')
        .bind(key, String(args[0]), real, label, new Date(now).toISOString()).run();
      await attLog(env, key, real, 'answer', label.slice(0, 100) + ' to question ' + args[0]);
    } else if (action !== 'state') throw new Error('Unknown action.');
  } catch (err) {
    await attLog(env, key, real, 'refused: ' + action, err.message);
    throw err;
  }
  // The student's own marks of today's rounds (round ids start with the date).
  const marks = (await env.DB.prepare('SELECT round, COALESCE(self, edited) AS time FROM att_marks WHERE class = ? AND email = ? AND present = 1 AND round >= ? AND round < ?')
    .bind(key, real, date + ' ', date + '~').all()).results;
  const answers = s.questions.length
    ? (await env.DB.prepare('SELECT qid, answer FROM att_answers WHERE class = ? AND email = ?').bind(key, real).all()).results : [];
  const view = att.studentView(s, real, marks, now, id => answers.find(a => a.qid === id) || null);
  // An instructor account that is not on the roster is sent to the instructor page instead of the roster error.
  if (!view.authorized && isAdmin(real, env)) view.instructor = true;
  return view;
}

// ---------------------------------------------------------------- instructor page

const ATT_READS = { whoami: 1, get: 1, log: 1, export: 1 };

/** Every instructor action except reads is logged (actor "email (instructor)"); a refused one is logged with its reason. */
async function attAdminCall(env, real, action, key, args) {
  const who = real + ' (instructor)';
  try {
    return await attAdminDo(env, real, who, action, key, args);
  } catch (err) {
    if (!ATT_READS[action]) {
      const shown = args.map(a => (typeof a === 'string' ? a.slice(0, 200) : JSON.stringify(a).slice(0, 200)));
      await attLog(env, key, who, 'refused: ' + action, shown.join(', ') + (shown.length ? ' | ' : '') + err.message);
    }
    throw err;
  }
}

async function attAdminDo(env, real, who, action, key, args) {
  const now = Date.now();
  if (action === 'whoami') return { email: real, classes: await attClassList(env) };

  if (action === 'createClass') {
    const newKey = String(args[0] || '').trim().toLowerCase();
    const title = String(args[1] || '').trim();
    if (!/^[a-z0-9-]{2,30}$/.test(newKey)) throw new Error('The class key must be 2 to 30 lowercase letters, digits, or hyphens.');
    if (!title) throw new Error('The class needs a title.');
    const res = await env.DB.prepare('INSERT OR IGNORE INTO att_classes (key, state) VALUES (?, ?)')
      .bind(newKey, JSON.stringify(att.newAttClass(title, now))).run();
    if (res.meta.changes !== 1) throw new Error('A class with the key "' + newKey + '" exists.');
    await attLog(env, newKey, who, 'create class', title);
    return { key: newKey, classes: await attClassList(env) };
  }

  if (action === 'deleteClass') {
    if (String(args[0]) !== key) throw new Error('Type the class key exactly to delete the class.');
    await readAtt(env, key);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM att_classes WHERE key = ?').bind(key),
      env.DB.prepare('DELETE FROM att_marks WHERE class = ?').bind(key),
      env.DB.prepare('DELETE FROM att_answers WHERE class = ?').bind(key),
      env.DB.prepare('DELETE FROM log WHERE class = ?').bind('att:' + key)
    ]);
    return { classes: await attClassList(env) };
  }

  // The activity log: args = [search text, who: 'all' | 'instructor' | 'students', limit]. Newest first.
  if (action === 'log') {
    const like = '%' + String(args[0] || '').replace(/[%_]/g, '') + '%';
    const whoFilter = args[1] === 'instructor' ? " AND actor LIKE '%(instructor)'" : args[1] === 'students' ? " AND actor NOT LIKE '%(instructor)'" : '';
    const limit = Math.min(Math.max(Number(args[2]) || 500, 1), 20000);
    const out = await env.DB.prepare('SELECT id, time, actor, action, detail FROM log WHERE class = ? AND (actor LIKE ? OR action LIKE ? OR detail LIKE ?)'
      + whoFilter + ' ORDER BY id DESC LIMIT ?').bind('att:' + key, like, like, like, limit).all();
    return { rows: out.results };
  }

  const s = await readAtt(env, key);
  const name = e => { const r = att.student(s, e); return r ? att.fullName(r) + ' (' + e + ')' : e; };
  const logs = [];  // [action, detail] lines written after the change succeeds

  // Everything stored about the class, for a full download (the secret stays out).
  if (action === 'export') {
    const state = Object.assign({}, s); delete state.secret;
    return { exportedAt: new Date(now).toISOString(), key: key, state: state,
             marks: (await env.DB.prepare('SELECT round, email, self, present, edited, by FROM att_marks WHERE class = ? ORDER BY round, email').bind(key).all()).results,
             answers: (await env.DB.prepare('SELECT qid, email, answer, time FROM att_answers WHERE class = ? ORDER BY qid, email').bind(key).all()).results,
             log: (await env.DB.prepare('SELECT id, time, actor, action, detail FROM log WHERE class = ? ORDER BY id').bind('att:' + key).all()).results };
  }

  if (action === 'setMark' || action === 'setMarks') {
    // Instructor override: present (true) or absent (false) per student and round; setMarks takes a list of [round, email, present].
    // Refused while a round is open, so that changes are made after the fact (the page saves them as a batch).
    if (att.windowAt(s, now)) throw new Error('Attendance is open. Change marks after it closes.');
    const list = action === 'setMark' ? [args] : (Array.isArray(args[0]) ? args[0] : []);
    if (!list.length || list.length > 2000) throw new Error('No change to save.');
    const stamp = new Date(now).toISOString();
    const stmts = [];
    list.forEach(a => {
      const round = String(a[0] || ''), email = canonEmail(a[1]);
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(round) || !email) throw new Error('A round and an email are needed.');
      // The student's own mark (self) is kept, so the row records the manual change: present - (self set) is +1, -1, or 0.
      if (a[2]) {
        stmts.push(env.DB.prepare('INSERT INTO att_marks (class, round, email, present, edited, by) VALUES (?, ?, ?, 1, ?, ?) '
          + 'ON CONFLICT (class, round, email) DO UPDATE SET present = 1, edited = excluded.edited, by = excluded.by')
          .bind(key, round, email, stamp, real));
      } else {
        stmts.push(env.DB.prepare('UPDATE att_marks SET present = 0, edited = ?, by = ? WHERE class = ? AND round = ? AND email = ?').bind(stamp, real, key, round, email),
          env.DB.prepare('DELETE FROM att_marks WHERE class = ? AND round = ? AND email = ? AND self IS NULL').bind(key, round, email));
      }
      logs.push([a[2] ? 'set present' : 'set absent', name(email) + ', round ' + round]);
    });
    await env.DB.batch(stmts);
  } else if (action === 'openNow') {
    const before = att.windowAt(s, now);
    att.ADMIN.openNow(s, args[0], now);
    const open = att.windowAt(s, now);
    await writeAtt(env, key, s);
    logs.push(['open now', 'round ' + open.id + ', until ' + open.close + (before ? ' (round ' + before.id + ' closed)' : '')]);
  } else if (action === 'closeNow') {
    const open = att.windowAt(s, now);
    att.ADMIN.closeNow(s, now);
    await writeAtt(env, key, s);
    logs.push(['close now', 'round ' + open.id + ', closed at ' + s.closed[open.id]]);
  } else if (action === 'extendNow') {
    att.ADMIN.extendNow(s, args[0], now);
    const open = att.windowAt(s, now);
    await writeAtt(env, key, s);
    logs.push(['extend', 'round ' + open.id + ' by ' + args[0] + ' min, until ' + open.close]);
  } else if (action === 'noteBackup') {
    att.ADMIN.noteBackup(s, now);
    await writeAtt(env, key, s);
    logs.push(['note backup', String(args[0] || 'downloaded')]);
  } else if (action === 'removeRound') {
    // A whole round goes: its window and every mark made in it.
    const scheduled = att.ADMIN.removeRound(s, args[0]);
    const res = await env.DB.batch([
      env.DB.prepare('DELETE FROM att_marks WHERE class = ? AND round = ?').bind(key, String(args[0])),
      env.DB.prepare('UPDATE att_classes SET state = ? WHERE key = ?').bind(JSON.stringify(s), key)
    ]);
    logs.push(['remove round', 'round ' + args[0] + ', ' + res[0].meta.changes + ' marks deleted' + (scheduled ? ' (scheduled window removed; restorable under Settings)' : '')]);
  } else if (action === 'askQuestion') {
    const q = att.ADMIN.askQuestion(s, args[0], args[1], args[2], args[3], args[4], now);
    await writeAtt(env, key, s);
    logs.push(['ask question', q.id + ' (' + q.kind + (q.kind === 'mc' ? ' ' + q.n : '') + ') for ' + args[4] + ' min' + (q.text ? ': ' + q.text.slice(0, 100) : '')]);
  } else if (action === 'closeQuestion') {
    att.ADMIN.closeQuestion(s, args[0], now);
    await writeAtt(env, key, s);
    logs.push(['close question', String(args[0])]);
  } else if (action === 'extendQuestion') {
    att.ADMIN.extendQuestion(s, args[0], args[1], now);
    await writeAtt(env, key, s);
    logs.push(['extend question', args[0] + ' by ' + args[1] + ' min']);
  } else if (action === 'deleteQuestion') {
    att.ADMIN.deleteQuestion(s, args[0]);
    await env.DB.batch([
      env.DB.prepare('UPDATE att_classes SET state = ? WHERE key = ?').bind(JSON.stringify(s), key),
      env.DB.prepare('DELETE FROM att_answers WHERE class = ? AND qid = ?').bind(key, String(args[0]))
    ]);
    logs.push(['delete question', String(args[0])]);
  } else if (action === 'importRoster') {
    const before = s.roster.map(r => r.email);
    att.ADMIN.importRoster(s, args[0]);
    await writeAtt(env, key, s);
    const after = s.roster.map(r => r.email);
    logs.push(['import roster', after.length + ' students; added: ' + (after.filter(e => before.indexOf(e) === -1).join(', ') || 'none')
      + '; dropped: ' + (before.filter(e => after.indexOf(e) === -1).join(', ') || 'none')]);
  } else if (action === 'saveSettings') {
    const before = JSON.stringify({ t: s.title, sch: s.schedule, skip: s.skip, p: s.points, code: s.code });
    att.ADMIN.saveSettings(s, args[0]);
    await writeAtt(env, key, s);
    const after = JSON.stringify({ t: s.title, sch: s.schedule, skip: s.skip, p: s.points, code: s.code });
    if (after !== before) logs.push(['save settings', after]);
  } else if (Object.prototype.hasOwnProperty.call(att.ADMIN, action)) {
    const before = s.roster.slice();
    const removed = action === 'removeStudent' ? name(canonEmail(args[0])) : '';
    att.ADMIN[action](s, ...args);
    await writeAtt(env, key, s);
    const added = s.roster.filter(r => before.indexOf(r) === -1).map(r => name(r.email)).join(', ');
    const detail = { addExtra: 'window ' + args[0] + ' ' + args[1] + ' to ' + args[2], removeExtra: 'window ' + args[0] + ' ' + (args[1] || ''),
                     addStudent: added, removeStudent: removed, setCorrect: args[0] + ': ' + (args[1] || 'none'),
                     excludeDate: args[0] + ' (does not count)', includeDate: args[0] + ' (counts again)', restoreRound: 'round ' + args[0] };
    logs.push([action.replace(/([A-Z])/g, c => ' ' + c.toLowerCase()), action in detail ? detail[action] : args.join(', ')]);
  } else if (action !== 'get') throw new Error('Unknown action.');

  if (logs.length) {
    const time = new Date().toISOString();
    await env.DB.batch(logs.map(l => env.DB.prepare(LOG_SQL + 'VALUES (?, ?, ?, ?, ?)').bind(time, 'att:' + key, who, l[0], String(l[1]).slice(0, 2000))));
  }

  const marks = (await env.DB.prepare('SELECT round, email, self, present, edited, by FROM att_marks WHERE class = ? ORDER BY round, email').bind(key).all()).results;
  const ids = marks.map(m => m.round).filter((d, i, a) => a.indexOf(d) === i);
  const answers = s.questions.length
    ? (await env.DB.prepare('SELECT qid, email, answer, time FROM att_answers WHERE class = ?').bind(key).all()).results : [];
  const roundsList = att.rounds(s, ids, now);
  const open = att.windowAt(s, now);
  // The secret is sent apart from the state (never in a download): the page computes the session codes from it and `now`.
  const state = Object.assign({}, s); delete state.secret;
  return { state: state, marks: marks, answers: answers, rounds: roundsList, today: att.nyParts(now).date,
           open: open, secret: s.secret, next: att.nextWindow(s, now), now: new Date(now).toISOString(),
           question: att.openQuestion(s, now), report: att.report(s, roundsList, marks, now) };
}
