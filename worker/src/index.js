/**
 * Group, dataset, and topic sign-up tool: backend (Cloudflare Worker + D1).
 * The pages in docs/ (GitHub Pages) call it. See README.md.
 *
 *   GET  /config  -> {clientId, classes}        public, needed before sign-in
 *   POST /        -> student page: {token, class, action, args, viewAs, note}
 *   POST /admin   -> instructor page: {token, class, action, args}
 *   /att/config, /att, /att/admin -> the attendance tool (see the end of this file)
 *
 * Each class is one row of the classes table holding its state as JSON (see
 * rules.js). A change is written only if the row's version is the one that was
 * read, so two simultaneous claims of the same item cannot both succeed: the
 * second is recomputed against the first one's result and refused.
 */

import { act, view, adminAct, isAdminAction, newClass, upgrade, canonEmail } from './rules.js';
import { SEED_DATASETS, SEED_TOPICS } from './seed.js';
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
      if (request.method === 'GET' && path === '/config') {
        return json({ clientId: env.GOOGLE_CLIENT_ID || '', classes: await classList(env) });
      }
      // The pages poll this cheap call and reload the state only when the number changed.
      if (request.method === 'GET' && path === '/version') {
        const key = new URL(request.url).searchParams.get('c') || '';
        const row = await env.DB.prepare('SELECT version FROM classes WHERE key = ?').bind(key).first();
        return json({ version: row ? row.version : -1 });
      }
      if (request.method === 'GET' && path === '/att/config') {
        return json({ clientId: env.GOOGLE_CLIENT_ID || '', classes: await attClassList(env) });
      }
      if (request.method === 'POST' && (path === '/' || path === '/admin' || path === '/att' || path === '/att/admin')) {
        const body = await request.text();
        if (body.length > 1000000) throw new Error('The request is too large.');
        const req = JSON.parse(body);
        const real = await verify(req.token, env);
        const admin = isAdmin(real, env);
        const args = Array.isArray(req.args) ? req.args.slice(0, 8) : [];
        const key = String(req.class || '');
        const action = String(req.action);
        if (path === '/admin' || path === '/att/admin') {
          if (!admin) throw new Error('The account ' + real + ' is not an instructor account.');
          const data = path === '/admin' ? await adminCall(env, real, action, key, args) : await attAdminCall(env, real, action, key, args);
          return json({ ok: true, data: data });
        }
        if (path === '/att') return json({ ok: true, state: await attStudentCall(env, real, action, key, args) });
        return json({ ok: true, state: await studentCall(env, real, admin, req, args) });
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
 * Returns the verified email of a Google sign-in token: checks Google's
 * signature, that the token was issued for this tool's client ID, and that it
 * has not expired. The error text SIGNIN instructs the page to show the
 * sign-in button again.
 */
async function verify(token, env) {
  try {
    const parts = String(token || '').split('.');
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
    return email;
  } catch (e) {
    throw new Error('SIGNIN');
  }
}

/** Instructors are the emails in the ADMIN_EMAILS secret. */
function isAdmin(email, env) {
  return !!email && String(env.ADMIN_EMAILS || '').toLowerCase().split(/[,;\s]+/).indexOf(email) !== -1;
}

// ---------------------------------------------------------------- storage

async function classList(env) {
  const out = await env.DB.prepare(
    "SELECT key, json_extract(state, '$.settings.title') AS title FROM classes ORDER BY key").all();
  return out.results;
}

async function readClass(env, key) {
  const row = await env.DB.prepare('SELECT version, state FROM classes WHERE key = ?').bind(key).first();
  if (!row) throw new Error('This link does not match any class.');
  return { version: row.version, state: upgrade(JSON.parse(row.state)), raw: row.state };
}

const LOG_SQL = 'INSERT INTO log (time, class, actor, action, detail) ';

function logNow(env, key, actor, action, detail) {
  return env.DB.prepare(LOG_SQL + 'VALUES (?, ?, ?, ?, ?)')
    .bind(new Date().toISOString(), key, actor, action, String(detail).slice(0, 2000)).run();
}

/**
 * Reads the class, applies fn (which changes the state in place and returns
 * log lines), and writes the result with its log lines in one transaction,
 * provided nobody else wrote in between. Otherwise it starts over on the
 * newer state. A refusal by fn is logged and passed on.
 */
async function mutate(env, key, who, action, args, fn) {
  for (let attempt = 0; attempt < 60; attempt++) {
    // Each round of simultaneous writers has one winner; the others wait briefly and recompute.
    if (attempt) await new Promise(r => setTimeout(r, Math.random() * Math.min(attempt, 10) * 15));
    const row = await readClass(env, key);
    let logs;
    try {
      logs = fn(row.state);
    } catch (err) {
      // Refused attempts are logged too, so the log shows what was tried and why it failed.
      const shown = args.map(a => (typeof a === 'string' ? a.slice(0, 200) : JSON.stringify(a).slice(0, 200)));
      await logNow(env, key, who, 'refused: ' + action, shown.join(', ') + (shown.length ? ' | ' : '') + err.message);
      throw err;
    }
    if (!logs.length) return { state: row.state, version: row.version };  // nothing changed
    const stamp = crypto.randomUUID();
    const time = new Date().toISOString();
    const guard = ' WHERE EXISTS (SELECT 1 FROM classes WHERE key = ? AND stamp = ?)';
    const res = await env.DB.batch([
      env.DB.prepare('UPDATE classes SET state = ?, version = version + 1, stamp = ? WHERE key = ? AND version = ?')
        .bind(JSON.stringify(row.state), stamp, key, row.version),
      // The state as it was before this change, for the History tab of the instructor page.
      env.DB.prepare('INSERT INTO snapshots (time, class, actor, action, detail, state) SELECT ?, ?, ?, ?, ?, ?' + guard)
        .bind(time, key, logs[0].actor, action.replace(/([A-Z])/g, c => ' ' + c.toLowerCase()),
              logs.map(l => l.detail).join('; ').slice(0, 2000), row.raw, key, stamp)
    ].concat(logs.map(l =>
      env.DB.prepare(LOG_SQL + 'SELECT ?, ?, ?, ?, ?' + guard)
        .bind(time, key, l.actor, l.action, String(l.detail).slice(0, 2000), key, stamp))));
    if (res[0].meta.changes === 1) return { state: row.state, version: row.version + 1 };
  }
  throw new Error('The page is busy. Try again in a few seconds.');
}

// ---------------------------------------------------------------- student page

async function studentCall(env, real, admin, req, args) {
  const key = String(req.class || '');
  const viewAs = String(req.viewAs || '').trim().toLowerCase();
  const action = String(req.action);
  if (action === 'state') {
    const row = await readClass(env, key);
    const v = view(row.state, real, viewAs, admin, Date.now());
    if (req.note === 'sign in' || req.note === 'open page') {
      await logNow(env, key, real, req.note, v.authorized ? (v.me || viewAs ? '' : 'instructor') : 'not on the class roster');
    }
    v.version = row.version;
    return v;
  }
  const who = real + (admin && viewAs ? ' (as ' + viewAs + ')' : '');
  const row = await mutate(env, key, who, action, args, s => act(s, real, action, args, viewAs, admin, Date.now()));
  const v = view(row.state, real, viewAs, admin, Date.now());
  v.version = row.version;
  return v;
}

// ---------------------------------------------------------------- instructor page

async function adminCall(env, real, action, key, args) {
  const who = real + ' (instructor)';
  if (action === 'whoami') return { email: real, classes: await classList(env) };

  if (action === 'createClass') {
    const newKey = String(args[0] || '').trim().toLowerCase();
    const title = String(args[1] || '').trim();
    if (!/^[a-z0-9-]{2,30}$/.test(newKey)) throw new Error('The class key must be 2 to 30 lowercase letters, digits, or hyphens.');
    if (!title) throw new Error('The class needs a title.');
    const state = newClass(title, SEED_DATASETS, SEED_TOPICS);
    if (args[2]) {
      const from = (await readClass(env, String(args[2]))).state;
      state.datasets = from.datasets;
      state.topics = from.topics;
      state.settings = Object.assign({}, from.settings, { title: title, deadline: '' });
    }
    const res = await env.DB.prepare('INSERT OR IGNORE INTO classes (key, state) VALUES (?, ?)')
      .bind(newKey, JSON.stringify(state)).run();
    if (res.meta.changes !== 1) throw new Error('A class with the key "' + newKey + '" exists.');
    await logNow(env, newKey, who, 'create class', title + (args[2] ? ' (catalogs copied from ' + args[2] + ')' : ''));
    return { key: newKey, classes: await classList(env) };
  }

  if (action === 'deleteClass') {
    if (String(args[0]) !== key) throw new Error('Type the class key exactly to delete the class.');
    await readClass(env, key);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM classes WHERE key = ?').bind(key),
      env.DB.prepare('DELETE FROM log WHERE class = ?').bind(key),
      env.DB.prepare('DELETE FROM snapshots WHERE class = ?').bind(key)
    ]);
    return { classes: await classList(env) };
  }

  if (action === 'get') return await readClass(env, key);

  // Every change saved a snapshot of the state before it. Newest first.
  if (action === 'snapshots') {
    const limit = Math.min(Math.max(Number(args[0]) || 300, 1), 5000);
    const out = await env.DB.prepare(
      'SELECT id, time, actor, action, detail FROM snapshots WHERE class = ? ORDER BY id DESC LIMIT ?').bind(key, limit).all();
    return { rows: out.results };
  }

  // Puts the class back to the state saved in one snapshot. The current state is snapshotted first, so a restore can itself be undone.
  if (action === 'restore') {
    const snap = await env.DB.prepare('SELECT id, time, actor, action, detail, state FROM snapshots WHERE class = ? AND id = ?')
      .bind(key, Number(args[0])).first();
    if (!snap) throw new Error('That snapshot does not exist.');
    const old = upgrade(JSON.parse(snap.state));
    return await mutate(env, key, who, action, [snap.id], s => {
      Object.keys(s).forEach(k => delete s[k]);
      Object.assign(s, old);
      return [{ actor: who, action: 'restore', detail: 'state as of ' + snap.time + ', before "' + snap.action + '" by ' + snap.actor + ' (snapshot ' + snap.id + ')' }];
    });
  }

  if (action === 'log') {
    const like = '%' + String(args[0] || '').replace(/[%_]/g, '') + '%';
    const limit = Math.min(Math.max(Number(args[1]) || 300, 1), 20000);
    const out = await env.DB.prepare(
      'SELECT id, time, actor, action, detail FROM log WHERE class = ? AND (actor LIKE ? OR action LIKE ? OR detail LIKE ?) ' +
      'ORDER BY id DESC LIMIT ?').bind(key, like, like, like, limit).all();
    return { rows: out.results };
  }

  if (!isAdminAction(action)) throw new Error('Unknown action.');
  return await mutate(env, key, who, action, action === 'importRoster' ? ['(file)'] : args,
    s => adminAct(s, real, action, args, Date.now()));
}

// ---------------------------------------------------------------- attendance tool
//
//   GET  /att/config          -> {clientId, classes}
//   POST /att        {token, class, action: 'state' | 'mark' | 'answer', args: [qid, answer]}   -> {ok, state}
//   POST /att/admin  {token, class, action, args}               -> {ok, data}
// Settings, roster, and questions are one JSON row per class (att_classes); marks are rows of
// att_marks and answers rows of att_answers.

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

// The attendance log shares the log table with the sign-up tool; its class key is prefixed so the two never mix.
const attLog = (env, key, actor, action, detail) => logNow(env, 'att:' + key, actor, action, detail || '');

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
      await attLog(env, key, real, 'answer', label + ' to question ' + args[0]);
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
  return att.studentView(s, real, marks, now, id => answers.find(a => a.qid === id) || null);
}

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
  // The secret is sent apart from the state (never in a download): the page computes the 10-second session codes from it and `now`.
  const state = Object.assign({}, s); delete state.secret;
  return { state: state, marks: marks, answers: answers, rounds: roundsList, today: att.nyParts(now).date,
           open: open, secret: s.secret, next: att.nextWindow(s, now), now: new Date(now).toISOString(),
           question: att.openQuestion(s, now), report: att.report(s, roundsList, marks, now) };
}
