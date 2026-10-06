/**
 * Email spelling and roster import, shared by attendance.js and index.js.
 * Copied from the group sign-up tool (RabbaniMaysam/group-signup, worker/src/rules.js) when the
 * attendance tool became its own repository on 2026-10-05; the two copies are independent now.
 */

const norm = s => String(s ?? '').trim().toLowerCase();
const text = s => String(s ?? '').trim();
/** One spelling per student: Montclair's @mail.montclair.edu addresses are the same accounts as @montclair.edu. */
export const canonEmail = s => norm(s).replace(/@mail\.montclair\.edu$/, '@montclair.edu');

export function parseCsv(csv) {
  const src = String(csv).replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (src[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.join('').trim() !== '');
}

/**
 * Reads a roster CSV into [{first, last, email}] (deduplicated by email, in file order). Two layouts:
 *   Canvas export: a "Student" column ("Last, First") and a "SIS Login ID" column (the part of the
 *     Montclair address before the @). The "Points Possible" row and Canvas's test student are skipped.
 *   Plain: first name, last name, and email columns in any order (extra columns are ignored).
 */
export function parseRoster(csv) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error('The file has no student rows.');
  const head = rows.shift().map(h => norm(h));
  const col = re => head.findIndex(h => re.test(h));
  const iStudent = col(/^student$/), iLogin = col(/login/);
  const iFirst = col(/first/), iLast = col(/last|surname|family/), iMail = col(/mail/);
  let read;
  if (iStudent >= 0 && iLogin >= 0) {
    read = r => {
      const name = text(r[iStudent]), login = norm(r[iLogin]);
      if (!login || norm(name) === 'student, test' || /^[0-9a-f]{32,}$/.test(login)) return null;  // Canvas test student, "Points Possible"
      const m = /^([^,]*),(.*)$/.exec(name);
      return { first: text(m ? m[2] : ''), last: text(m ? m[1] : name),
               email: login.includes('@') ? canonEmail(login) : login + '@montclair.edu' };
    };
  } else if (iFirst >= 0 && iLast >= 0 && iMail >= 0) {
    read = r => ({ first: text(r[iFirst]), last: text(r[iLast]), email: canonEmail(r[iMail]) });
  } else {
    throw new Error('The header row must have "Student" and "SIS Login ID" columns (Canvas export), or first name, last name, and email columns.');
  }
  const seen = {}, out = [];
  rows.forEach(r => {
    const st = read(r);
    if (!st || !st.email || seen[st.email]) return;
    seen[st.email] = true;
    out.push(st);
  });
  if (!out.length) throw new Error('The file has no student rows.');
  return out;
}
