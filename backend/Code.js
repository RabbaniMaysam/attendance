/**
 * Group, dataset, and topic sign-up tool: backend.
 * Google Apps Script bound to a Google Sheet, published as a web app that the
 * GitHub Pages front end (docs/) calls. See README.md.
 *
 * Source of truth:
 *   Roster sheet   -> who may use the tool and which group each student is in
 *   Groups sheet   -> one row per group: leader, claimed dataset and topic
 *   Requests sheet -> requests to join a group and their outcome
 *   Datasets, Topics sheets -> catalogs
 *   Settings sheet -> deadline, size limits, instructor emails, sign-in client ID
 * Every change is made under a script lock, so two simultaneous claims of the
 * same item cannot both succeed.
 */

const SH = {
  settings: 'Settings',
  roster: 'Roster',
  groups: 'Groups',
  requests: 'Requests',
  datasets: 'Datasets',
  topics: 'Topics',
  log: 'Log'
};

const HEAD = {
  settings: ['Setting', 'Value', 'Note'],
  roster: ['First name', 'Last name', 'Email', 'Group', 'Joined at'],
  groups: ['Group', 'Leader email', 'Created at', 'Dataset code', 'Own dataset link', 'Dataset claimed at',
           'Topic code', 'Topic claimed at', 'Members', 'Dataset name', 'Topic name'],
  requests: ['Time', 'Email', 'Group', 'Status', 'Decided at'],
  datasets: ['Code', 'Name', 'Link', 'Own choice', 'Reserved'],
  topics: ['Code', 'Topic', 'Description'],
  log: ['Time', 'Email', 'Action', 'Detail']
};

// ---------------------------------------------------------------- web API

/** Public configuration the page needs before anyone signs in. */
function doGet() {
  const set = settings_();
  return json_({
    title: String(set['Course title'] || 'Group sign-up'),
    clientId: String(set['Google client ID'] || '').trim()
  });
}

/** Body: {token, action, args, viewAs}. Reply: {ok, state} or {ok: false, error}. */
function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    out = { ok: true, state: handle_(verify_(req.token), req.action, req.args || [], req.viewAs) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return json_(out);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Returns the verified email of a Google sign-in token. The error text SIGNIN
 * instructs the page to show the sign-in button again.
 */
function verify_(token) {
  if (!token) throw new Error('SIGNIN');
  const cache = CacheService.getScriptCache();
  const key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token)));
  const hit = cache.get(key);
  if (hit) return hit;
  const res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('SIGNIN');
  const p = JSON.parse(res.getContentText());
  const clientId = String(settings_()['Google client ID'] || '').trim();
  const secondsLeft = Number(p.exp) - Math.floor(Date.now() / 1000);
  if (!clientId || p.aud !== clientId || String(p.email_verified) !== 'true' || !(secondsLeft > 0)) {
    throw new Error('SIGNIN');
  }
  const email = norm_(p.email);
  cache.put(key, email, Math.min(21600, secondsLeft));
  log_(email, 'sign in', '');
  return email;
}

const ACTIONS = {
  createGroup: createGroup_,
  requestJoin: requestJoin_,
  cancelRequest: cancelRequest_,
  decideRequest: decideRequest_,
  removeMember: removeMember_,
  leaveGroup: leaveGroup_,
  claimDataset: claimDataset_,
  claimTopic: claimTopic_
};

/** real = verified email of the caller. viewAs = roster email an instructor previews as. */
function handle_(real, action, args, viewAs) {
  if (action === 'state') return getState_(real, viewAs);
  const fn = ACTIONS[action];
  if (!fn) throw new Error('Unknown action.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('The page is busy. Try again in a few seconds.');
  try {
    const set = settings_();
    const email = actingEmail_(real, viewAs, set);
    const roster = table_(SH.roster);
    const me = roster.find(function (r) { return norm_(r['Email']) === email; });
    if (!email || !me) throw new Error('This account is not on the class roster.');
    if (isClosed_(set)) throw new Error('The sign-up deadline has passed. Contact your instructor for changes.');
    const ctx = {
      email: email,
      preview: email !== real,
      actor: email === real ? email : email + ' (preview by ' + real + ')',
      set: set,
      roster: roster,
      me: me,
      groups: groups_(),
      requests: table_(SH.requests)
    };
    fn.apply(null, [ctx].concat(args));
    SpreadsheetApp.flush();
  } catch (err) {
    // Refused attempts are logged too, so the Log sheet shows what a student tried and why it failed.
    log_(real + (norm_(viewAs) ? ' (as ' + norm_(viewAs) + ')' : ''), 'refused: ' + action,
      args.join(', ') + (args.length ? ' | ' : '') + err.message);
    throw err;
  } finally {
    lock.releaseLock();
  }
  return getState_(real, viewAs);
}

// ---------------------------------------------------------------- state

/** Everything the page displays. Plain strings, numbers, and booleans only. */
function getState_(real, viewAs) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const set = settings_();
  const email = actingEmail_(real, viewAs, set);
  const roster = table_(SH.roster).filter(function (r) { return norm_(r['Email']); });
  const me = roster.find(function (r) { return norm_(r['Email']) === email; });
  const admin = isAdmin_(real, set);
  if (!email || (!me && !admin)) return { authorized: false, email: email };

  const nameOf = function (mail) {
    const r = roster.find(function (x) { return norm_(x['Email']) === norm_(mail); });
    return r ? fullName_(r) : String(mail);
  };
  const deadline = isDate_(set['Deadline']) ? set['Deadline'] : null;
  const maxSize = num_(set['Maximum group size'], 3);
  const groups = groups_();
  const pending = table_(SH.requests).filter(function (q) { return q['Status'] === 'pending'; });
  const datasets = table_(SH.datasets).filter(function (d) { return !blank_(d['Code']); });
  const topics = table_(SH.topics).filter(function (t) { return !blank_(t['Code']); });

  const myGroup = me ? String(me['Group'] || '') : '';
  const g0 = groups.find(function (g) { return String(g['Group']) === myGroup; });
  const leading = !!g0 && norm_(g0['Leader email']) === email;
  const myRequest = pending.find(function (q) { return norm_(q['Email']) === email; });

  return {
    authorized: true,
    admin: admin,
    email: email,
    preview: email !== real,
    // Instructors receive the roster so the page can offer "preview as student".
    roster: admin
      ? roster.map(function (r) { return { email: norm_(r['Email']), name: fullName_(r) }; })
      : null,
    me: me ? {
      name: fullName_(me),
      group: myGroup,
      leader: leading,
      request: myRequest ? String(myRequest['Group']) : ''
    } : null,
    // Requests waiting for this student's decision (group leaders only).
    requests: leading
      ? pending.filter(function (q) { return String(q['Group']) === myGroup; })
          .map(function (q) { return { email: norm_(q['Email']), name: nameOf(q['Email']) }; })
      : [],
    title: String(set['Course title'] || 'Group sign-up'),
    deadlineText: deadline
      ? Utilities.formatDate(deadline, ss.getSpreadsheetTimeZone(), "EEEE, MMMM d, yyyy 'at' h:mm a z")
      : '',
    closed: isClosed_(set),
    maxSize: maxSize,
    minToClaim: num_(set['Minimum members to claim'], 2),
    canCreate: groups.length < num_(set['Maximum number of groups'], 20),
    groups: groups.map(function (g) {
      const name = String(g['Group']);
      const members = roster.filter(function (r) { return String(r['Group']) === name; });
      return {
        name: name,
        leader: nameOf(g['Leader email']),
        members: members.map(function (r) {
          // Emails are included only for the leader's own group, to remove a member.
          return { name: fullName_(r), email: leading && name === myGroup ? norm_(r['Email']) : '' };
        }),
        full: members.length >= maxSize,
        dataset: blank_(g['Dataset code']) ? '' : String(g['Dataset code']),
        ownLink: String(g['Own dataset link'] || ''),
        topic: blank_(g['Topic code']) ? '' : String(g['Topic code'])
      };
    }),
    datasets: datasets.map(function (d) {
      const code = String(d['Code']);
      return {
        code: code,
        name: String(d['Name']),
        link: String(d['Link'] || ''),
        own: yes_(d['Own choice']),
        reserved: String(d['Reserved'] || ''),
        claimedBy: groups
          .filter(function (g) { return !blank_(g['Dataset code']) && String(g['Dataset code']) === code; })
          .map(function (g) { return String(g['Group']); })
      };
    }),
    topics: topics.map(function (t) {
      const code = String(t['Code']);
      return {
        code: code,
        topic: String(t['Topic']),
        description: String(t['Description'] || ''),
        claimedBy: groups
          .filter(function (g) { return !blank_(g['Topic code']) && String(g['Topic code']) === code; })
          .map(function (g) { return String(g['Group']); })
      };
    })
  };
}

// ---------------------------------------------------------------- group actions

function createGroup_(ctx) {
  const current = String(ctx.me['Group'] || '');
  if (current) throw new Error('You are in ' + current + '. Leave it before creating a new group.');
  if (ctx.groups.length >= num_(ctx.set['Maximum number of groups'], 20)) {
    throw new Error('No new group can be created now. Ask to join an existing group.');
  }
  let n = 1;
  const used = ctx.groups.map(function (g) { return String(g['Group']); });
  while (used.indexOf('Group ' + n) !== -1) n++;
  const name = 'Group ' + n;
  const sh = sheet_(SH.groups);
  const r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, HEAD.groups.length).setValues([[
    name, ctx.email, new Date(), '', '', '', '', '',
    '=IFERROR(TEXTJOIN(", ", TRUE, FILTER(Roster!A:A & " " & Roster!B:B, Roster!D:D = A' + r + ')), "")',
    '=IF(D' + r + '="", "", IFERROR(VLOOKUP(D' + r + ', Datasets!A:B, 2, FALSE), ""))',
    '=IF(G' + r + '="", "", IFERROR(VLOOKUP(G' + r + ', Topics!A:B, 2, FALSE), ""))'
  ]]);
  setMember_(ctx.me, name);
  closeRequests_(ctx, function (q) { return norm_(q['Email']) === ctx.email; }, 'cancelled');
  log_(ctx.actor, 'create group', name);
}

function requestJoin_(ctx, groupName) {
  const current = String(ctx.me['Group'] || '');
  if (current) throw new Error('You are in ' + current + '. Leave it before asking to join another group.');
  const g = group_(ctx, groupName);
  if (!g) throw new Error('That group no longer exists.');
  if (members_(ctx, groupName).length >= num_(ctx.set['Maximum group size'], 3)) {
    throw new Error(groupName + ' is full.');
  }
  closeRequests_(ctx, function (q) { return norm_(q['Email']) === ctx.email; }, 'cancelled');
  sheet_(SH.requests).appendRow([new Date(), ctx.email, String(groupName), 'pending', '']);
  log_(ctx.actor, 'request to join', String(groupName));
  notify_(ctx, g['Leader email'], fullName_(ctx.me) + ' asks to join ' + groupName,
    fullName_(ctx.me) + ' (' + ctx.email + ') asks to join ' + groupName +
    '. Open the sign-up page to approve or decline the request.');
}

function cancelRequest_(ctx) {
  const n = closeRequests_(ctx, function (q) { return norm_(q['Email']) === ctx.email; }, 'cancelled');
  if (n) log_(ctx.actor, 'cancel request', '');
}

function decideRequest_(ctx, requesterEmail, approve) {
  const g = leaderGroup_(ctx);
  const name = String(g['Group']);
  const who = norm_(requesterEmail);
  const mine = function (q) { return norm_(q['Email']) === who && String(q['Group']) === name; };
  if (!ctx.requests.some(function (q) { return q['Status'] === 'pending' && mine(q); })) {
    throw new Error('That request is no longer pending.');
  }
  if (!approve) {
    closeRequests_(ctx, mine, 'declined');
    log_(ctx.actor, 'decline request', who + ' -> ' + name);
    notify_(ctx, who, 'Your request to join ' + name + ' was declined',
      'The leader of ' + name + ' declined your request. Open the sign-up page to create a group or ask another group.');
    return;
  }
  const student = ctx.roster.find(function (r) { return norm_(r['Email']) === who; });
  if (!student || String(student['Group'] || '')) {
    closeRequests_(ctx, mine, 'cancelled');
    throw new Error(student ? fullName_(student) + ' has joined another group.' : 'That student is no longer on the roster.');
  }
  const maxSize = num_(ctx.set['Maximum group size'], 3);
  const size = members_(ctx, name).length;
  if (size >= maxSize) throw new Error(name + ' is full. Remove a member or decline the request.');
  setMember_(student, name);
  closeRequests_(ctx, mine, 'approved');
  log_(ctx.actor, 'approve request', who + ' -> ' + name);
  notify_(ctx, who, 'You joined ' + name, 'The leader of ' + name + ' approved your request.');
  if (size + 1 >= maxSize) declineAll_(ctx, name, 'declined (group full)', name + ' is now full.');
}

function removeMember_(ctx, memberEmail) {
  const g = leaderGroup_(ctx);
  const name = String(g['Group']);
  const who = norm_(memberEmail);
  if (who === ctx.email) throw new Error('Use Leave to leave your own group.');
  const student = ctx.roster.find(function (r) { return norm_(r['Email']) === who && String(r['Group']) === name; });
  if (!student) throw new Error('That student is not in ' + name + '.');
  setMember_(student, '');
  log_(ctx.actor, 'remove member', who + ' from ' + name);
  notify_(ctx, who, 'You were removed from ' + name,
    'The leader of ' + name + ' removed you from the group. Open the sign-up page to create a group or ask another group.');
}

/**
 * A leader who leaves is replaced by the member who joined earliest. A group
 * whose last member leaves is deleted, which releases its dataset and topic.
 */
function leaveGroup_(ctx) {
  const name = String(ctx.me['Group'] || '');
  if (!name) return;
  const g = group_(ctx, name);
  const others = members_(ctx, name)
    .filter(function (r) { return r._row !== ctx.me._row; })
    .sort(function (a, b) { return time_(a['Joined at']) - time_(b['Joined at']); });
  setMember_(ctx.me, '');
  log_(ctx.actor, 'leave group', name);
  if (!g) return;
  if (!others.length) {
    declineAll_(ctx, name, 'declined (group closed)', name + ' no longer exists.');
    sheet_(SH.groups).deleteRow(g._row);
    log_(ctx.actor, 'delete group', name + ' became empty; its claims are released');
  } else if (norm_(g['Leader email']) === ctx.email) {
    const next = norm_(others[0]['Email']);
    sheet_(SH.groups).getRange(g._row, 2).setValue(next);
    log_(ctx.actor, 'new leader', name + ': ' + next);
    notify_(ctx, next, 'You are now the leader of ' + name,
      'The previous leader left ' + name + '. You now approve join requests and claim the dataset and topic.');
  }
}

// ---------------------------------------------------------------- claims

function claimDataset_(ctx, code, ownLink) {
  const g = claimingGroup_(ctx);
  const d = table_(SH.datasets).find(function (x) { return !blank_(x['Code']) && String(x['Code']) === String(code); });
  if (!d) throw new Error('That dataset does not exist.');
  if (!blank_(d['Reserved'])) throw new Error('"' + d['Name'] + '" is reserved.');
  let link = '';
  if (yes_(d['Own choice'])) {
    link = String(ownLink || '').trim();
    if (!/^https?:\/\/\S+$/i.test(link)) throw new Error('Paste the full web link of the dataset you chose.');
  } else {
    const holder = ctx.groups.find(function (x) {
      return !blank_(x['Dataset code']) && String(x['Dataset code']) === String(code) && x._row !== g._row;
    });
    if (holder) throw new Error('"' + d['Name'] + '" was just claimed by ' + holder['Group'] + '. Choose another dataset.');
  }
  sheet_(SH.groups).getRange(g._row, 4, 1, 3).setValues([[d['Code'], link, new Date()]]);
  log_(ctx.actor, 'claim dataset', g['Group'] + ': ' + d['Code'] + ' ' + d['Name'] + (link ? ' ' + link : ''));
}

function claimTopic_(ctx, code) {
  const g = claimingGroup_(ctx);
  const t = table_(SH.topics).find(function (x) { return !blank_(x['Code']) && String(x['Code']) === String(code); });
  if (!t) throw new Error('That topic does not exist.');
  const holder = ctx.groups.find(function (x) {
    return !blank_(x['Topic code']) && String(x['Topic code']) === String(code) && x._row !== g._row;
  });
  if (holder) throw new Error('"' + t['Topic'] + '" was just claimed by ' + holder['Group'] + '. Choose another topic.');
  sheet_(SH.groups).getRange(g._row, 7, 1, 2).setValues([[t['Code'], new Date()]]);
  log_(ctx.actor, 'claim topic', g['Group'] + ': ' + t['Code'] + ' ' + t['Topic']);
}

// ---------------------------------------------------------------- shared pieces

function group_(ctx, name) {
  return ctx.groups.find(function (x) { return String(x['Group']) === String(name); });
}

function members_(ctx, name) {
  return ctx.roster.filter(function (r) { return String(r['Group']) === String(name); });
}

function leaderGroup_(ctx) {
  const g = group_(ctx, String(ctx.me['Group'] || ''));
  if (!g || norm_(g['Leader email']) !== ctx.email) throw new Error('Only the group leader can do this.');
  return g;
}

function claimingGroup_(ctx) {
  if (!String(ctx.me['Group'] || '')) throw new Error('Create or join a group first.');
  const g = leaderGroup_(ctx);
  const min = num_(ctx.set['Minimum members to claim'], 2);
  if (members_(ctx, g['Group']).length < min) {
    throw new Error('Your group needs at least ' + min + ' members before it can claim a dataset or topic.');
  }
  return g;
}

function setMember_(rosterRow, groupName) {
  sheet_(SH.roster).getRange(rosterRow._row, 4, 1, 2)
    .setValues([[groupName, groupName ? new Date() : '']]);
}

/** Marks the pending requests that satisfy test with the given status. Returns how many. */
function closeRequests_(ctx, test, status) {
  const sh = sheet_(SH.requests);
  let n = 0;
  ctx.requests.forEach(function (q) {
    if (q['Status'] !== 'pending' || !test(q)) return;
    sh.getRange(q._row, 4, 1, 2).setValues([[status, new Date()]]);
    q['Status'] = status;
    n++;
  });
  return n;
}

function declineAll_(ctx, groupName, status, reason) {
  const waiting = ctx.requests.filter(function (q) {
    return q['Status'] === 'pending' && String(q['Group']) === groupName;
  }).map(function (q) { return norm_(q['Email']); });
  closeRequests_(ctx, function (q) { return String(q['Group']) === groupName; }, status);
  waiting.forEach(function (mail) {
    notify_(ctx, mail, 'Your request to join ' + groupName + ' was closed',
      reason + ' Open the sign-up page to create a group or ask another group.');
  });
}

/** Email notice. Never sent during an instructor preview, and never fatal. */
function notify_(ctx, to, subject, body) {
  if (ctx.preview || !yes_(ctx.set['Email notifications']) || !norm_(to)) return;
  try {
    const link = String(ctx.set['Page link'] || '').trim();
    MailApp.sendEmail(norm_(to), '[' + String(ctx.set['Course title'] || 'Group sign-up') + '] ' + subject,
      body + (link ? '\n\n' + link : ''));
  } catch (err) {
    log_('system', 'email failed', norm_(to) + ': ' + err.message);
  }
}

// ---------------------------------------------------------------- helpers

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" is missing. Run Sign-up tool > Initial setup.');
  return sh;
}

/** Sheet rows as objects keyed by header, with _row = sheet row number. */
function table_(name) {
  const values = sheet_(name).getDataRange().getValues();
  const head = values.shift().map(function (h) { return String(h).trim(); });
  return values.map(function (r, i) {
    const o = { _row: i + 2 };
    head.forEach(function (h, j) { o[h] = r[j]; });
    return o;
  });
}

function groups_() {
  return table_(SH.groups).filter(function (g) { return !blank_(g['Group']); });
}

function settings_() {
  const out = {};
  table_(SH.settings).forEach(function (r) { out[String(r['Setting']).trim()] = r['Value']; });
  return out;
}

function isClosed_(set) {
  return isDate_(set['Deadline']) && Date.now() > set['Deadline'].getTime();
}

/** Instructors are the emails listed in the Settings sheet. */
function isAdmin_(email, set) {
  if (!email) return false;
  return String(set['Instructor emails'] || '').toLowerCase().split(/[,;\s]+/).indexOf(email) !== -1;
}

/**
 * The account a request acts for. Only an instructor may act for another
 * roster email (the "preview as student" control). For everyone else the
 * viewAs value is ignored.
 */
function actingEmail_(real, viewAs, set) {
  const other = norm_(viewAs);
  return other && isAdmin_(real, set) ? other : real;
}

function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]'; }
function time_(v) { return isDate_(v) ? v.getTime() : 0; }
function num_(v, fallback) { const n = Number(v); return n > 0 ? n : fallback; }
function norm_(s) { return String(s || '').trim().toLowerCase(); }
function blank_(v) { return v === '' || v === null || v === undefined; }
function yes_(v) { return /^(y|yes|true|1)$/i.test(String(v).trim()); }
function fullName_(r) { return (String(r['First name'] || '') + ' ' + String(r['Last name'] || '')).trim(); }

function log_(email, action, detail) {
  sheet_(SH.log).appendRow([new Date(), email, action, detail]);
}

// ---------------------------------------------------------------- spreadsheet menu

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Sign-up tool')
    .addItem('Initial setup', 'setup')
    .addItem('Import roster CSV', 'showRosterDialog')
    .addToUi();
}

/** Builds the sheets. Safe to repeat: a sheet that exists is left untouched. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone('America/New_York');

  make_(ss, SH.settings, HEAD.settings, [
    ['Course title', 'ECON573 group sign-up', 'Shown at the top of the student page'],
    ['Deadline', '', 'Date and time (Eastern). Students cannot change anything afterward. Blank = no deadline'],
    ['Maximum group size', 3, 'The group creator plus the students the creator approves'],
    ['Minimum members to claim', 2, 'A group smaller than this cannot claim a dataset or topic'],
    ['Maximum number of groups', 20, 'Students are not shown this number'],
    ['Instructor emails', Session.getEffectiveUser().getEmail(), 'Comma-separated. These accounts see the whole board and can preview as any student'],
    ['Google client ID', '', 'From Google Cloud Console (see README). Sign-in fails while this is blank'],
    ['Page link', '', 'Address of the student page, added to email notices'],
    ['Email notifications', 'yes', 'yes = email the leader about join requests and the student about the decision']
  ]);
  make_(ss, SH.roster, HEAD.roster, []);
  make_(ss, SH.groups, HEAD.groups, []);
  make_(ss, SH.requests, HEAD.requests, []);
  make_(ss, SH.datasets, HEAD.datasets, SEED_DATASETS);
  make_(ss, SH.topics, HEAD.topics, SEED_TOPICS);
  make_(ss, SH.log, HEAD.log, []);

  const first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);
  ss.toast('Setup finished. Fill in the Settings sheet, then import the roster.');
}

function make_(ss, name, head, rows) {
  if (ss.getSheetByName(name)) return;
  const sh = ss.insertSheet(name, ss.getSheets().length);
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (rows.length) sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function showRosterDialog() {
  const html = HtmlService.createHtmlOutputFromFile('RosterDialog').setWidth(420).setHeight(230);
  SpreadsheetApp.getUi().showModalDialog(html, 'Import roster CSV');
}

/**
 * Replaces the roster with the CSV. Students who remain keep their group.
 * The CSV needs a header row with first name, last name, and email columns
 * (any order; extra columns are ignored).
 */
function importRoster(csvText) {
  const rows = Utilities.parseCsv(String(csvText).replace(/^﻿/, ''))
    .filter(function (r) { return r.join('').trim() !== ''; });
  if (rows.length < 2) throw new Error('The file has no student rows.');
  const head = rows.shift().map(function (h) { return String(h).trim().toLowerCase(); });
  const col = function (re) { return head.findIndex(function (h) { return re.test(h); }); };
  const iFirst = col(/first/), iLast = col(/last|surname|family/), iMail = col(/mail/);
  if (iFirst < 0 || iLast < 0 || iMail < 0) {
    throw new Error('The header row must name a first name, a last name, and an email column.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const old = {};
    table_(SH.roster).forEach(function (r) { old[norm_(r['Email'])] = r; });
    const seen = {};
    const out = [];
    rows.forEach(function (r) {
      const email = norm_(r[iMail]);
      if (!email || seen[email]) return;
      seen[email] = true;
      const prev = old[email];
      out.push([String(r[iFirst]).trim(), String(r[iLast]).trim(), email,
                prev ? prev['Group'] : '', prev ? prev['Joined at'] : '']);
    });
    const dropped = Object.keys(old).filter(function (e) { return e && !seen[e]; });
    const sh = sheet_(SH.roster);
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, HEAD.roster.length).clearContent();
    if (out.length) sh.getRange(2, 1, out.length, HEAD.roster.length).setValues(out);
    log_(norm_(Session.getEffectiveUser().getEmail()), 'import roster', out.length + ' students, ' + dropped.length + ' removed');
    return out.length + ' students on the roster. ' + dropped.length + ' removed.';
  } finally {
    lock.releaseLock();
  }
}
