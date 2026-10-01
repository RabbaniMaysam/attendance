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
 *   extra      [{date, open, close}] one-off windows (a moved class, or "open now"); several per date allowed
 *   closed     {round id: 'HH:MM'}  windows closed early ("close now", or superseded by "open now")
 *   extended   {round id: 'HH:MM'}  windows extended while open ("extend"): the new closing time
 *   exclude    ['YYYY-MM-DD', ...]  dates that do not count: hidden in the grid, left out of the sessions,
 *              the percentages, and the points (their marks are kept; a date can be included again)
 *   questions  [{id, kind: 'tf' | 'yn' | 'mc', n, text, correct, opened, closes}]  in-class questions, oldest first;
 *              times are ISO instants; a question is open while now < closes. Answers are rows of att_answers.
 *   points     {mode: 'per' | 'total', value}  attendance points: per session, or a total divided equally
 *              among all sessions of the semester (see sessionDates and report)
 *   code       true when students must type the round's session code to mark themselves present
 *   secret     random string; the session code of a round is derived from it (see sessionCode)
 *   backupAt   ISO instant of the last full download of the class's data noted by the instructor, or ''
 * All clock times are New York local time. Every window is one attendance round, identified by
 * 'YYYY-MM-DD HH:MM' (its date and opening time); marks are rows of att_marks keyed by round and
 * email, so a day with three windows has three rounds and three columns in the grid.
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
           schedule: Object.assign({}, DEFAULT_SCHEDULE), skip: DEFAULT_SKIP.slice(), extra: [], closed: {}, extended: {}, exclude: [],
           questions: [], points: { mode: 'total', value: 0 }, code: true, secret: randomSecret(), backupAt: '' };
}

const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
export const roundId = (date, open) => date + ' ' + open;

export function randomSecret() {
  let out = '';
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/**
 * The 4-digit session code of a round, shown with the QR code and typed by students: a hash of the
 * class's secret and the round id, so it is fixed for the round, differs between rounds, and cannot
 * be guessed from earlier codes. (cyrb53 hash.)
 */
export function sessionCode(s, id) {
  const str = String(s.secret || '') + '|' + id;
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return String(n % 10000).padStart(4, '0');
}

/** Whether a date counts (is not excluded). */
export const counts = (s, date) => (s.exclude || []).indexOf(date) === -1;

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

/**
 * The attendance windows (rounds) on one New York date, earliest first: {id, date, open, close, extra}.
 * An extended window ends at the recorded later minute. A window closed early keeps its id and date
 * but ends at the recorded minute (a zero-length window when closed in its opening minute: listed
 * for the grid, never open).
 */
export function windowsOn(s, date, weekday) {
  const out = s.extra.filter(x => x.date === date).map(x => ({ open: x.open, close: x.close, extra: true }));
  const sch = s.schedule;
  if (sch.days.indexOf(weekday) !== -1 && s.skip.indexOf(date) === -1 &&
      (!sch.start || date >= sch.start) && (!sch.end || date <= sch.end)) {
    out.push({ open: sch.open, close: sch.close, extra: false });
  }
  out.forEach(x => {
    x.id = roundId(date, x.open); x.date = date;
    const late = (s.extended || {})[x.id];
    if (late && toMin(late) > toMin(x.close)) x.close = late;
    const early = s.closed[x.id];
    if (early && toMin(early) < toMin(x.close)) x.close = hhmm(Math.max(toMin(x.open), toMin(early)));
  });
  return out.sort((a, b) => toMin(a.open) - toMin(b.open) || (a.extra ? 1 : -1));
}

/** The window open at ms (the latest-opened one when two overlap), or null. closesAt: the ISO instant it closes. */
export function windowAt(s, ms) {
  const p = nyParts(ms);
  const w = windowsOn(s, p.date, p.weekday).filter(x => p.minutes >= toMin(x.open) && p.minutes < toMin(x.close)).pop();
  if (!w) return null;
  // Time zone offsets are whole minutes, so the seconds within the UTC minute are the seconds within the New York minute.
  return { id: w.id, date: p.date, open: w.open, close: w.close, closesAt: new Date(ms + (toMin(w.close) - p.minutes) * 60000 - ms % 60000).toISOString() };
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
 * (while a window is open, and for 2 hours after any window of the day opened): 8 s, so a new
 * round or question appears quickly. Otherwise the moment the next window opens, at most 30 s
 * away, so an "open now" outside class shows within half a minute.
 */
const IDLE = 30000;
export function refreshIn(s, ms) {
  if (openQuestion(s, ms)) return 3000;
  const now = nyParts(ms);
  if (windowAt(s, ms)) return 8000;
  if (windowsOn(s, now.date, now.weekday).some(w => now.minutes >= toMin(w.open) && now.minutes < toMin(w.open) + 120)) return 8000;
  const nx = nextWindow(s, ms);
  if (!nx) return IDLE;
  const target = nx.daysAhead * 86400000 + (toMin(nx.open) - now.minutes) * 60000 - ms % 60000;
  return Math.max(1000, Math.min(target + 500, IDLE));
}

/**
 * All rounds that have opened, from the semester start (or the class creation) through now, plus
 * rounds that have marks (their window may since have been removed): [{id, date, open, close}], oldest first.
 */
export function rounds(s, markRounds, ms) {
  const now = nyParts(ms);
  const first = s.schedule.start || s.createdAt || now.date;
  const set = {};
  markRounds.forEach(id => { set[id] = { id: id, date: id.slice(0, 10), open: id.slice(11), close: '' }; });
  // Walk day by day from the first date to today (at most a year).
  const t0 = Date.parse(first + 'T12:00:00Z');
  if (!isNaN(t0)) {
    for (let k = 0; k < 370; k++) {
      const d = new Date(t0 + k * 86400000).toISOString().slice(0, 10);
      if (d > now.date) break;
      const wd = new Date(t0 + k * 86400000).getUTCDay();
      windowsOn(s, d, wd).forEach(w => {
        if (d < now.date || toMin(w.open) <= now.minutes) set[w.id] = { id: w.id, date: d, open: w.open, close: w.close };
      });
    }
  }
  return Object.keys(set).sort().map(id => set[id]);
}

/**
 * Every class session of the semester, past and future, as sorted dates: the scheduled days from the
 * first to the last class day (minus the no-class days), the dates of one-off windows, and the dates
 * of rounds that have marks, minus the excluded dates. Without a last class day the schedule is walked
 * through today or the latest round, whichever is later. Points are divided among these dates.
 */
export function sessionDates(s, markRounds, ms) {
  const now = nyParts(ms);
  const set = {};
  markRounds.forEach(id => { set[id.slice(0, 10)] = true; });
  s.extra.forEach(x => { set[x.date] = true; });
  const first = s.schedule.start || s.createdAt || now.date;
  const last = s.schedule.end || Object.keys(set).concat([now.date]).sort().pop();
  const t0 = Date.parse(first + 'T12:00:00Z');
  if (!isNaN(t0)) {
    for (let k = 0; k < 370; k++) {
      const d = new Date(t0 + k * 86400000).toISOString().slice(0, 10);
      if (d > last) break;
      if (windowsOn(s, d, new Date(t0 + k * 86400000).getUTCDay()).some(w => !w.extra)) set[d] = true;
    }
  }
  return Object.keys(set).filter(d => counts(s, d)).sort();
}

/**
 * Attendance counts and points. roundsList: rounds() output; marks: [{round, email, present}].
 * Points per session: points.value in mode 'per', or points.value / number of sessions in mode 'total'.
 * A session's points are split equally among its rounds; a student earns a round's share when present.
 * Rounds on excluded dates are left out of everything here.
 * Returns {dates, perSession, total, sessions: [{date, rounds: [{id, open, present}], points, opened}],
 *          students: {email: {present, rounds, points, possible}}} where rounds counts the rounds that
 * have opened, possible the points of the sessions that have opened, and total the semester's points.
 */
export function report(s, roundsList, marks, ms) {
  roundsList = roundsList.filter(x => counts(s, x.date));
  const dates = sessionDates(s, roundsList.map(x => x.id), ms);
  const n = dates.length;
  const pts = s.points || { mode: 'total', value: 0 };
  const perSession = pts.mode === 'total' ? (n ? pts.value / n : 0) : pts.value;
  const byDate = {};
  dates.forEach(d => { byDate[d] = { date: d, rounds: [], points: perSession, opened: false }; });
  roundsList.forEach(x => {
    if (!byDate[x.date]) return;  // a round on a date that is not a session (cannot happen: mark rounds are sessions)
    byDate[x.date].rounds.push({ id: x.id, open: x.open, present: 0 });
    byDate[x.date].opened = true;
  });
  const share = {};  // round id -> points
  Object.keys(byDate).forEach(d => { byDate[d].rounds.forEach(r => { share[r.id] = perSession / byDate[d].rounds.length; }); });
  const students = {};
  s.roster.forEach(r => { students[r.email] = { present: 0, rounds: roundsList.length, points: 0, possible: 0 }; });
  const possible = dates.filter(d => byDate[d].opened).length * perSession;
  Object.keys(students).forEach(e => { students[e].possible = possible; });
  marks.forEach(m => {
    if (!m.present || !(m.round in share)) return;
    const d = m.round.slice(0, 10);
    const st = students[m.email];
    if (!st) return;  // a student no longer on the roster
    byDate[d].rounds.find(x => x.id === m.round).present++;
    st.present++; st.points += share[m.round];
  });
  return { dates: dates, perSession: perSession, total: perSession * n, sessions: dates.map(d => byDate[d]), students: students };
}

export function student(s, email) { return s.roster.find(r => r.email === canonEmail(email)) || null; }
export const fullName = r => (r.first + ' ' + r.last).trim();

// ---------------------------------------------------------------- student view

/**
 * Everything the student page displays. marks: the student's own marks of today's rounds [{round, time}];
 * answerOf(id): the student's own answer row for a question, or null.
 */
export function studentView(s, email, marks, ms, answerOf) {
  const me = student(s, email);
  if (!me) return { authorized: false, email: email, title: s.title };
  const open = windowAt(s, ms);
  const mine = open ? (marks || []).find(m => m.round === open.id) : null;
  // The open question, or the one that closed in the last 3 minutes (so the result stays on screen briefly).
  const q = openQuestion(s, ms) || s.questions.filter(x => ms - Date.parse(x.closes) < 180000).slice(-1)[0] || null;
  return {
    authorized: true, email: email, name: fullName(me), title: s.title,
    date: nyParts(ms).date,
    open: open,                                   // {id, date, open, close, closesAt} or null
    needCode: !!s.code,                           // the student must type the round's session code
    marked: mine ? mine.time : '',                // ISO time of the mark in the open round, or ''
    today: (marks || []).map(m => m.time).sort(), // ISO times of all of today's marks
    next: open ? null : nextWindow(s, ms),
    question: q ? questionView(q, answerOf ? answerOf(q.id) : null, ms) : null,
    refreshIn: refreshIn(s, ms)
  };
}

/** Checks the session code a student typed for the open round (when the class requires one). */
export function checkCode(s, open, code) {
  if (!s.code) return;
  if (String(code ?? '').trim() !== sessionCode(s, open.id)) throw new Error('Wrong session code. Type the 4-digit code shown by your instructor.');
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
    const old = s.points || { mode: 'total', value: 0 };
    const mode = v.pointsMode === undefined ? old.mode : (v.pointsMode === 'per' ? 'per' : 'total');
    const value = Number(v.points === undefined || v.points === '' ? old.value : v.points);
    if (!(value >= 0 && value <= 1000)) throw new Error('Attendance points must be a number from 0 to 1000.');
    s.title = title;
    s.schedule = { days: days.sort(), open: open, close: close, start: start, end: end };
    s.skip = skip.filter((d, i) => skip.indexOf(d) === i).sort();
    s.points = { mode: mode, value: value };
    if (v.code !== undefined) s.code = !!v.code;
  },

  /** Excludes a date: hidden in the grid and left out of the sessions, percentages, and points. Marks are kept. */
  excludeDate(s, date) {
    date = text(date);
    if (!isDate(date)) throw new Error('The date must be YYYY-MM-DD.');
    if (counts(s, date)) s.exclude = s.exclude.concat([date]).sort();
  },

  /** Includes an excluded date again. */
  includeDate(s, date) {
    date = text(date);
    if (counts(s, date)) throw new Error(date + ' is not excluded.');
    s.exclude = s.exclude.filter(d => d !== date);
  },

  /** "Extend": the open round (scheduled or one-off) closes `minutes` later than it would, at most at 23:59. */
  extendNow(s, minutes, nowMs) {
    const n = Number(minutes);
    if (!(n >= 1 && n <= 600)) throw new Error('Minutes must be 1 to 600.');
    const open = windowAt(s, nowMs);
    if (!open) throw new Error('Attendance is not open.');
    s.extended[open.id] = hhmm(Math.min(toMin(open.close) + n, 1439));
  },

  /** Records that the instructor downloaded (or otherwise saved) the class's data in full. */
  noteBackup(s, nowMs) {
    s.backupAt = new Date(nowMs).toISOString();
  },

  /** A one-off window (a new round) on one date, for a moved class or "open now". Replaces an extra window with the same opening time. */
  addExtra(s, date, open, close) {
    date = text(date); open = text(open); close = text(close);
    if (!isDate(date)) throw new Error('The date must be YYYY-MM-DD.');
    if (!isTime(open) || !isTime(close) || toMin(close) <= toMin(open)) throw new Error('Times must be HH:MM with close after open.');
    open = hhmm(toMin(open)); close = hhmm(toMin(close));
    s.extra = s.extra.filter(x => !(x.date === date && x.open === open)).concat([{ date: date, open: open, close: close }])
      .sort((a, b) => (roundId(a.date, a.open) < roundId(b.date, b.open) ? -1 : 1));
    delete s.closed[roundId(date, open)]; delete s.extended[roundId(date, open)];
  },

  /** "Open now": closes the open round, if any, and starts a new one from this minute for `minutes` minutes. */
  openNow(s, minutes, nowMs) {
    const n = Math.min(Math.max(Number(minutes) || 0, 1), 600);
    const p = nyParts(nowMs);
    const open = windowAt(s, nowMs);
    if (open && open.open === hhmm(p.minutes)) throw new Error('A round opened this minute; wait for the next minute to open another.');
    if (open) s.closed[open.id] = hhmm(p.minutes);
    ADMIN.addExtra(s, p.date, hhmm(p.minutes), hhmm(Math.min(p.minutes + n, 1439)));
  },

  /** "Close now": ends the open round at this minute. Marks made so far are kept. */
  closeNow(s, nowMs) {
    const open = windowAt(s, nowMs);
    if (!open) throw new Error('Attendance is not open.');
    s.closed[open.id] = hhmm(nyParts(nowMs).minutes);
  },

  /** Removes a one-off window. Marks made in it stay in att_marks and in the grid. */
  removeExtra(s, date, open) {
    date = text(date); open = text(open);
    s.extra = s.extra.filter(x => !(x.date === date && (!open || x.open === open)));
    delete s.closed[roundId(date, open)]; delete s.extended[roundId(date, open)];
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

/** Fills in fields added later. */
export function upgradeAtt(s) {
  s.roster = s.roster || []; s.skip = s.skip || []; s.extra = s.extra || []; s.questions = s.questions || []; s.closed = s.closed || {};
  s.extended = s.extended || {}; s.exclude = s.exclude || []; s.backupAt = s.backupAt || '';
  if (s.code === undefined) s.code = true;
  // The secret is created on the first read of an older class; the Worker writes the state back (see readAtt).
  s.schedule = Object.assign({}, DEFAULT_SCHEDULE, s.schedule || {});
  s.points = Object.assign({ mode: 'total', value: 0 }, s.points || {});
  delete s.sessions; delete s.cutoff;
  return s;
}
