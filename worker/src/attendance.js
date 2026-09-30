/**
 * Attendance tool: the rules. Pure functions, no storage, so test/test_attendance.mjs
 * and the Worker exercise the same code.
 *
 * State of an attendance class (att_classes.state):
 *   title      course title
 *   createdAt  'YYYY-MM-DD' (New York date the class was created)
 *   roster     [{first, last, email}]
 *   schedule   {days: [0-6, 0 = Sunday], open: 'HH:MM', close: 'HH:MM', start: 'YYYY-MM-DD' or '', end: 'YYYY-MM-DD' or ''}
 *   skip       ['YYYY-MM-DD', ...]   scheduled days with no class (holidays)
 *   extra      [{date, open, close}] one-off windows (a moved class, or "open now")
 * All clock times are New York local time. Marks are stored separately (att_marks), keyed by
 * date and email, whichever window (weekly or one-off) they were made in.
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
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d);
const isTime = t => { const m = toMin(t); return !isNaN(m) && m >= 0 && m < 1440; };

export function newAttClass(title, nowMs) {
  return { title: title, createdAt: nyParts(nowMs).date, roster: [],
           schedule: { days: [2, 4], open: '07:50', close: '08:01', start: '', end: '' }, skip: [], extra: [] };
}

/** The attendance windows on one New York date, earliest first. */
export function windowsOn(s, date, weekday) {
  const out = s.extra.filter(x => x.date === date).map(x => ({ open: x.open, close: x.close, extra: true }));
  const sch = s.schedule;
  if (sch.days.indexOf(weekday) !== -1 && s.skip.indexOf(date) === -1 &&
      (!sch.start || date >= sch.start) && (!sch.end || date <= sch.end)) {
    out.push({ open: sch.open, close: sch.close, extra: false });
  }
  return out.sort((a, b) => toMin(a.open) - toMin(b.open));
}

/** The window open at ms, or null. */
export function windowAt(s, ms) {
  const p = nyParts(ms);
  const w = windowsOn(s, p.date, p.weekday).find(x => p.minutes >= toMin(x.open) && p.minutes < toMin(x.close));
  return w ? { date: p.date, open: w.open, close: w.close } : null;
}

/** The next window that opens after ms, within 70 days, or null. */
export function nextWindow(s, ms) {
  const now = nyParts(ms);
  let last = '';
  for (let k = 0; k <= 70; k++) {
    // Stepping in half days never skips a New York date across a clock change; duplicates are skipped.
    const p = nyParts(ms + k * 43200000);
    if (p.date === last) continue;
    last = p.date;
    const w = windowsOn(s, p.date, p.weekday).find(x => p.date > now.date || toMin(x.open) > now.minutes);
    if (w) return { date: p.date, open: w.open, close: w.close, daysAhead: k === 0 ? 0 : Math.round((k * 43200000) / 86400000) };
  }
  return null;
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

/** All class dates from the semester start (or the class creation) through today, plus dates that have marks. */
export function sessionDates(s, markDates, ms) {
  const today = nyParts(ms).date;
  const first = s.schedule.start || s.createdAt || today;
  const set = {};
  markDates.forEach(d => { set[d] = true; });
  // Walk day by day from the first date to today (at most a year).
  const t0 = Date.parse(first + 'T12:00:00Z');
  if (!isNaN(t0)) {
    for (let k = 0; k < 370; k++) {
      const d = new Date(t0 + k * 86400000).toISOString().slice(0, 10);
      if (d > today) break;
      const wd = new Date(t0 + k * 86400000).getUTCDay();
      if (windowsOn(s, d, wd).length) set[d] = true;
    }
  }
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
  saveSettings(s, v) {
    const title = text(v && v.title);
    if (!title) throw new Error('The course title is empty.');
    const days = Array.isArray(v.days) ? v.days.map(Number).filter(d => d >= 0 && d <= 6) : [];
    const open = text(v.open), close = text(v.close);
    if (!isTime(open) || !isTime(close)) throw new Error('Open and close times must be HH:MM (24-hour).');
    if (toMin(close) <= toMin(open)) throw new Error('The close time must be after the open time.');
    const start = text(v.start), end = text(v.end);
    if ((start && !isDate(start)) || (end && !isDate(end))) throw new Error('Semester dates must be YYYY-MM-DD.');
    const skip = String(v.skip || '').split(/[\s,;]+/).map(text).filter(Boolean);
    const badSkip = skip.find(d => !isDate(d));
    if (badSkip) throw new Error('"' + badSkip + '" is not a date (YYYY-MM-DD).');
    s.title = title;
    s.schedule = { days: days.sort(), open: open, close: close, start: start, end: end };
    s.skip = skip.filter((d, i) => skip.indexOf(d) === i).sort();
  },

  /** A one-off window on one date, for a moved class or "open now". Replaces any extra window on that date. */
  addExtra(s, date, open, close) {
    date = text(date); open = text(open); close = text(close);
    if (!isDate(date)) throw new Error('The date must be YYYY-MM-DD.');
    if (!isTime(open) || !isTime(close) || toMin(close) <= toMin(open)) throw new Error('Times must be HH:MM with close after open.');
    s.extra = s.extra.filter(x => x.date !== date).concat([{ date: date, open: open, close: close }]).sort((a, b) => (a.date < b.date ? -1 : 1));
  },

  /** Removes the one-off window on a date. Marks made in it stay in att_marks and in the grid. */
  removeExtra(s, date) {
    s.extra = s.extra.filter(x => x.date !== text(date));
  },

  /** Replaces the roster (layouts: see parseRoster in rules.js). Marks of dropped students are kept in att_marks. */
  importRoster(s, csv) {
    s.roster = parseRoster(csv);
    s.roster.sort((a, b) => (a.last + ' ' + a.first).toLowerCase() < (b.last + ' ' + b.first).toLowerCase() ? -1 : 1);
  }
};

/** "Open now for N minutes": an extra window on today's date from now. Returns the window. */
export function openNowWindow(nowMs, minutes) {
  const n = Math.min(Math.max(Number(minutes) || 0, 1), 600);
  const p = nyParts(nowMs);
  const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  return { date: p.date, open: hhmm(p.minutes), close: hhmm(Math.min(p.minutes + n, 1439)) };
}

/** Fills in fields added later. */
export function upgradeAtt(s) {
  s.roster = s.roster || []; s.skip = s.skip || []; s.extra = s.extra || [];
  s.schedule = Object.assign({ days: [2, 4], open: '07:50', close: '08:01', start: '', end: '' }, s.schedule || {});
  delete s.sessions;
  return s;
}
