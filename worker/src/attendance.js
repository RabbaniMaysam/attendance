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
 *   cutoff     {date, close} or null  "close now": on that date no window stays open past close (HH:MM)
 *   questions  [{id, kind: 'tf' | 'yn' | 'mc', n, text, correct, opened, closes}]  in-class questions, oldest first;
 *              times are ISO instants; a question is open while now < closes. Answers are rows of att_answers.
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

/** The schedule a new class starts with (Fall 2026: Tue/Thu 7:50 to 8:05 am, Oct 1 to Dec 8, with the no-class days). */
export const DEFAULT_SCHEDULE = { days: [2, 4], open: '07:50', close: '08:05', start: '2026-10-01', end: '2026-12-08' };
export const DEFAULT_SKIP = ['2026-10-06', '2026-10-20', '2026-10-22', '2026-11-19', '2026-11-26'];

export function newAttClass(title, nowMs) {
  return { title: title, createdAt: nyParts(nowMs).date, roster: [],
           schedule: Object.assign({}, DEFAULT_SCHEDULE), skip: DEFAULT_SKIP.slice(), extra: [], cutoff: null, questions: [] };
}

const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

// ---------------------------------------------------------------- in-class questions

const KINDS = { tf: ['True', 'False'], yn: ['Yes', 'No'], mc: ['A', 'B', 'C', 'D', 'E'] };
/** The answer labels of a question. */
export function options(q) { return q.kind === 'mc' ? KINDS.mc.slice(0, q.n) : KINDS[q.kind]; }
export function isQuestionOpen(q, ms) { return Date.parse(q.closes) > ms; }
/** The question students can answer now, or null (at most one is open). */
export function openQuestion(s, ms) { return s.questions.find(q => isQuestionOpen(q, ms)) || null; }
export function question(s, id) { return s.questions.find(q => q.id === String(id)) || null; }
/** Marks a question for the student page: answered label and, once closed, the correct label. */
function questionView(q, answer, ms) {
  const open = isQuestionOpen(q, ms);
  return { id: q.id, kind: q.kind, text: q.text, options: options(q), closes: q.closes, open: open,
           answered: answer ? answer.answer : '', correct: open ? '' : q.correct };
}

/** The attendance windows on one New York date, earliest first. */
export function windowsOn(s, date, weekday) {
  const out = s.extra.filter(x => x.date === date).map(x => ({ open: x.open, close: x.close, extra: true }));
  const sch = s.schedule;
  if (sch.days.indexOf(weekday) !== -1 && s.skip.indexOf(date) === -1 &&
      (!sch.start || date >= sch.start) && (!sch.end || date <= sch.end)) {
    out.push({ open: sch.open, close: sch.close, extra: false });
  }
  // Closed early: the window ends at the cutoff (a window the cutoff precedes keeps its date in the grid, with no open minute).
  if (s.cutoff && s.cutoff.date === date) {
    out.forEach(x => { if (toMin(x.close) > toMin(s.cutoff.close)) x.close = hhmm(Math.max(toMin(x.open), toMin(s.cutoff.close))); });
  }
  return out.sort((a, b) => toMin(a.open) - toMin(b.open));
}

/** The window open at ms, or null. closesAt: the ISO instant it closes. */
export function windowAt(s, ms) {
  const p = nyParts(ms);
  const w = windowsOn(s, p.date, p.weekday).find(x => p.minutes >= toMin(x.open) && p.minutes < toMin(x.close));
  if (!w) return null;
  // Time zone offsets are whole minutes, so the seconds within the UTC minute are the seconds within the New York minute.
  return { date: p.date, open: w.open, close: w.close, closesAt: new Date(ms + (toMin(w.close) - p.minutes) * 60000 - ms % 60000).toISOString() };
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
    const w = windowsOn(s, p.date, p.weekday).find(x => toMin(x.close) > toMin(x.open) && (p.date > now.date || toMin(x.open) > now.minutes));
    if (w) return { date: p.date, open: w.open, close: w.close, daysAhead: k === 0 ? 0 : Math.round((k * 43200000) / 86400000) };
  }
  return null;
}

/**
 * Milliseconds until the student page should reload. While a question is open: 3 s. During class
 * (from the day's first window until 2 hours after it opens): 8 s, so a new question appears quickly.
 * Otherwise the moment the attendance window opens or closes, at most 30 s away, so an "open now"
 * or "close now" outside class shows within half a minute.
 */
const IDLE = 30000;
export function refreshIn(s, ms) {
  if (openQuestion(s, ms)) return 3000;
  const now = nyParts(ms);
  const secs = ms % 60000;
  const open = windowAt(s, ms);
  const first = windowsOn(s, now.date, now.weekday)[0];
  if (first && now.minutes >= toMin(first.open) && now.minutes < toMin(first.open) + 120) return 8000;
  let target;
  if (open) target = (toMin(open.close) - now.minutes) * 60000 - secs;
  else {
    const nx = nextWindow(s, ms);
    if (!nx) return IDLE;
    target = nx.daysAhead * 86400000 + (toMin(nx.open) - now.minutes) * 60000 - secs;
  }
  return Math.max(1000, Math.min(target + 500, IDLE));
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

/**
 * Everything the student page displays. mark: the student's own mark for today, or null;
 * answerOf(id): the student's own answer row for a question, or null.
 */
export function studentView(s, email, mark, ms, answerOf) {
  const me = student(s, email);
  if (!me) return { authorized: false, email: email, title: s.title };
  const open = windowAt(s, ms);
  // The open question, or the one that closed in the last 3 minutes (so the result stays on screen briefly).
  const q = openQuestion(s, ms) || s.questions.filter(x => ms - Date.parse(x.closes) < 180000).slice(-1)[0] || null;
  return {
    authorized: true, email: email, name: fullName(me), title: s.title,
    date: nyParts(ms).date,
    open: open,                                   // {date, open, close} or null
    marked: mark ? mark.time : '',                // ISO time of today's mark, or ''
    next: open ? null : nextWindow(s, ms),
    question: q ? questionView(q, answerOf ? answerOf(q.id) : null, ms) : null,
    refreshIn: refreshIn(s, ms)
  };
}

/** Checks a student's answer; returns the label to store. */
export function checkAnswer(s, id, answer, ms) {
  const q = question(s, id);
  if (!q) throw new Error('That question no longer exists.');
  if (!isQuestionOpen(q, ms)) throw new Error('The question is closed.');
  const label = options(q).find(o => o.toLowerCase() === String(answer || '').trim().toLowerCase());
  if (!label) throw new Error('Choose one of the answers.');
  return label;
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
    if (s.cutoff && s.cutoff.date === date) s.cutoff = null;  // a new window on the day undoes an early close
  },

  /** "Close now": ends the open window at this minute. Marks made so far are kept. */
  closeNow(s, nowMs) {
    const open = windowAt(s, nowMs);
    if (!open) throw new Error('Attendance is not open.');
    s.cutoff = { date: open.date, close: hhmm(nyParts(nowMs).minutes) };
  },

  /** Removes the one-off window on a date. Marks made in it stay in att_marks and in the grid. */
  removeExtra(s, date) {
    s.extra = s.extra.filter(x => x.date !== text(date));
  },

  /** Replaces the roster (layouts: see parseRoster in rules.js). Marks of dropped students are kept in att_marks. */
  importRoster(s, csv) {
    s.roster = parseRoster(csv);
    sortRoster(s);
  },

  /** Adds one student. The email may be the Montclair login ID alone (the part before the @). */
  addStudent(s, first, last, email) {
    first = text(first); last = text(last);
    let mail = canonEmail(email);
    if (mail && !mail.includes('@')) mail = mail + '@montclair.edu';
    if (!/^\S+@\S+\.\S+$/.test(mail)) throw new Error('That email address is not valid.');
    if (!first && !last) throw new Error('A name is needed.');
    if (student(s, mail)) throw new Error(mail + ' is on the roster.');
    s.roster.push({ first: first, last: last, email: mail });
    sortRoster(s);
  },

  /** Removes one student. Marks are kept in att_marks but no longer shown. */
  removeStudent(s, email) {
    const mail = canonEmail(email);
    if (!student(s, mail)) throw new Error(mail + ' is not on the roster.');
    s.roster = s.roster.filter(r => r.email !== mail);
  },

  /**
   * Opens a question for `minutes` minutes (closing any open one). kind: tf, yn, or mc with n choices (2 to 5);
   * text and correct are optional. Returns the new question.
   */
  askQuestion(s, kind, n, text_, correct, minutes, nowMs) {
    if (!KINDS[kind]) throw new Error('The question type must be True/False, Yes/No, or multiple choice.');
    n = kind === 'mc' ? Number(n) : KINDS[kind].length;
    if (!(n >= 2 && n <= 5)) throw new Error('A multiple-choice question has 2 to 5 choices.');
    const q = { id: String(nowMs) + '-' + String(s.questions.length + 1), kind: kind, n: n, text: text(text_).slice(0, 500),
                correct: '', opened: new Date(nowMs).toISOString(), closes: '' };
    q.correct = checkCorrect(q, correct);
    const mins = Number(minutes);
    if (!(mins >= 1 && mins <= 600)) throw new Error('Minutes must be 1 to 600.');
    q.closes = new Date(nowMs + mins * 60000).toISOString();
    s.questions.forEach(x => { if (isQuestionOpen(x, nowMs)) x.closes = new Date(nowMs).toISOString(); });
    s.questions.push(q);
    return q;
  },

  closeQuestion(s, id, nowMs) {
    const q = mustQuestion(s, id);
    if (isQuestionOpen(q, nowMs)) q.closes = new Date(nowMs).toISOString();
  },

  /** Adds minutes to an open question, or reopens a closed one for that many minutes (closing any other open one). */
  extendQuestion(s, id, minutes, nowMs) {
    const q = mustQuestion(s, id);
    const mins = Number(minutes);
    if (!(mins >= 1 && mins <= 600)) throw new Error('Minutes must be 1 to 600.');
    const from = isQuestionOpen(q, nowMs) ? Date.parse(q.closes) : nowMs;
    s.questions.forEach(x => { if (x !== q && isQuestionOpen(x, nowMs)) x.closes = new Date(nowMs).toISOString(); });
    q.closes = new Date(Math.min(from + mins * 60000, nowMs + 600 * 60000)).toISOString();
  },

  /** Sets or clears the correct answer (also after the question closed). */
  setCorrect(s, id, correct) {
    const q = mustQuestion(s, id);
    q.correct = checkCorrect(q, correct);
  },

  /** Removes a question. The Worker deletes its answers. */
  deleteQuestion(s, id) {
    mustQuestion(s, id);
    s.questions = s.questions.filter(q => q.id !== String(id));
  }
};

function mustQuestion(s, id) {
  const q = question(s, id);
  if (!q) throw new Error('That question no longer exists.');
  return q;
}

/** '' or one of the question's labels (case-insensitive). */
function checkCorrect(q, correct) {
  const c = text(correct);
  if (!c) return '';
  const label = options(q).find(o => o.toLowerCase() === c.toLowerCase());
  if (!label) throw new Error('The correct answer must be one of ' + options(q).join(', ') + '.');
  return label;
}

function sortRoster(s) {
  s.roster.sort((a, b) => (a.last + ' ' + a.first).toLowerCase() < (b.last + ' ' + b.first).toLowerCase() ? -1 : 1);
}

/** "Open now for N minutes": an extra window on today's date from now. Returns the window. */
export function openNowWindow(nowMs, minutes) {
  const n = Math.min(Math.max(Number(minutes) || 0, 1), 600);
  const p = nyParts(nowMs);
  return { date: p.date, open: hhmm(p.minutes), close: hhmm(Math.min(p.minutes + n, 1439)) };
}

/** Fills in fields added later. */
export function upgradeAtt(s) {
  s.roster = s.roster || []; s.skip = s.skip || []; s.extra = s.extra || []; s.questions = s.questions || []; s.cutoff = s.cutoff || null;
  s.schedule = Object.assign({}, DEFAULT_SCHEDULE, s.schedule || {});
  delete s.sessions;
  return s;
}
