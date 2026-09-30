/**
 * Attendance tool: the rules. Pure functions, no storage, so test/test_attendance.mjs
 * and the Worker exercise the same code.
 *
 * State of an attendance class (att_classes.state):
 *   title      course title
 *   roster     [{first, last, email}]
 *   sessions   [{date: 'YYYY-MM-DD', open: 'HH:MM', close: 'HH:MM'}]  the dates and windows when attendance is open
 * All clock times are New York local time. Marks are stored separately (att_marks).
 */

import { parseRoster, canonEmail } from './rules.js';

export const TZ = 'America/New_York';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const text = s => String(s ?? '').trim();

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });

/** New York date, weekday, and minute of day at the instant ms. */
export function nyParts(ms) {
  const p = {};
  fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  const hour = Number(p.hour) % 24;
  return { date: p.year + '-' + p.month + '-' + p.day, weekday: DAYS.indexOf(p.weekday),
           minutes: hour * 60 + Number(p.minute) };
}

const toMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(text(t)); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T12:00:00Z'));
const isTime = t => { const m = toMin(t); return !isNaN(m) && m >= 0 && m < 1440; };
const bySessionOrder = (a, b) => (a.date + a.open).localeCompare(b.date + b.open);

export function newAttClass(title) {
  return { title: title, roster: [], sessions: [] };
}

/** Checks one session row and returns it in canonical form. */
function session(v) {
  const date = text(v && v.date), open = text(v && v.open), close = text(v && v.close);
  if (!isDate(date)) throw new Error('"' + date + '" is not a date (YYYY-MM-DD).');
  if (!isTime(open) || !isTime(close)) throw new Error('Times must be HH:MM (24-hour) on ' + date + '.');
  if (toMin(close) <= toMin(open)) throw new Error('The close time must be after the open time on ' + date + '.');
  return { date: date, open: hhmm(toMin(open)), close: hhmm(toMin(close)) };
}

/** The window open at ms, or null. */
export function windowAt(s, ms) {
  const p = nyParts(ms);
  const w = s.sessions.find(x => x.date === p.date && p.minutes >= toMin(x.open) && p.minutes < toMin(x.close));
  return w ? { date: w.date, open: w.open, close: w.close } : null;
}

/** The next session that opens after ms, or null. */
export function nextWindow(s, ms) {
  const p = nyParts(ms);
  const w = s.sessions.slice().sort(bySessionOrder).find(x => x.date > p.date || (x.date === p.date && toMin(x.open) > p.minutes));
  if (!w) return null;
  const days = Math.round((Date.parse(w.date + 'T12:00:00Z') - Date.parse(p.date + 'T12:00:00Z')) / 86400000);
  return { date: w.date, open: w.open, close: w.close, daysAhead: days };
}

/** Milliseconds until the open/closed status next changes (capped at 6 hours). */
export function refreshIn(s, ms) {
  const now = nyParts(ms);
  const secs = ms % 60000;
  const open = windowAt(s, ms);
  let target;
  if (open) target = (toMin(open.close) - now.minutes) * 60000 - secs;
  else {
    const nx = nextWindow(s, ms);
    if (!nx) return 6 * 3600000;
    // Across days the clock-change error is at most an hour; the page recomputes on each reload.
    target = nx.daysAhead * 86400000 + (toMin(nx.open) - now.minutes) * 60000 - secs;
  }
  return Math.max(1000, Math.min(target + 500, 6 * 3600000));
}

/** Session dates through today, plus dates that have marks, sorted. */
export function sessionDates(s, markDates, ms) {
  const today = nyParts(ms).date;
  const set = {};
  markDates.forEach(d => { set[d] = true; });
  s.sessions.forEach(x => { if (x.date <= today) set[x.date] = true; });
  return Object.keys(set).sort();
}

export function student(s, email) { return s.roster.find(r => r.email === canonEmail(email)) || null; }
export const fullName = r => (r.first + ' ' + r.last).trim();

// ---------------------------------------------------------------- student view

/** Everything the student page displays. mark: the student's own mark for today, or null. */
export function studentView(s, email, mark, ms) {
  const me = student(s, email);
  if (!me) return { authorized: false, email: email, title: s.title };
  const open = windowAt(s, ms);
  return {
    authorized: true, email: email, name: fullName(me), title: s.title,
    date: nyParts(ms).date,
    open: open,                                   // {date, open, close} or null
    marked: mark ? mark.time : '',                // ISO time of today's mark, or ''
    next: open ? null : nextWindow(s, ms),
    refreshIn: refreshIn(s, ms)
  };
}

// ---------------------------------------------------------------- instructor actions (change the state in place)

export const ADMIN = {
  saveTitle(s, title) {
    title = text(title);
    if (!title) throw new Error('The course title is empty.');
    s.title = title;
  },

  /** Replaces the whole session list. Identical rows are merged; rows are kept in date order. */
  saveSessions(s, list) {
    if (!Array.isArray(list)) throw new Error('No sessions were sent.');
    const seen = {};
    s.sessions = list.map(session).filter(x => {
      const k = x.date + x.open + x.close;
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    }).sort(bySessionOrder);
  },

  /** Adds one session (used by "open now"). */
  addSession(s, date, open, close) {
    ADMIN.saveSessions(s, s.sessions.concat([{ date: date, open: open, close: close }]));
  },

  /** Replaces the roster (layouts: see parseRoster in rules.js). Marks of dropped students are kept in att_marks. */
  importRoster(s, csv) {
    s.roster = parseRoster(csv);
    s.roster.sort((a, b) => (a.last + ' ' + a.first).toLowerCase() < (b.last + ' ' + b.first).toLowerCase() ? -1 : 1);
  }
};

/** "Open now for N minutes": a session on today's date from now. */
export function openNowWindow(nowMs, minutes) {
  const n = Math.min(Math.max(Number(minutes) || 0, 1), 600);
  const p = nyParts(nowMs);
  return { date: p.date, open: hhmm(p.minutes), close: hhmm(Math.min(p.minutes + n, 1439)) };
}

/** Fills in fields added later and drops the fields of the earlier weekly schedule. */
export function upgradeAtt(s) {
  s.roster = s.roster || [];
  s.sessions = s.sessions || (s.extra || []).map(x => ({ date: x.date, open: x.open, close: x.close }));
  ['schedule', 'skip', 'extra', 'createdAt'].forEach(k => { delete s[k]; });
  return s;
}
