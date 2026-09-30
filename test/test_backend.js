// Tests the backend rules against an in-memory mock of the Google Sheet.
// Run from the repository root:  node test/test_backend.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = path.join(__dirname, '..', 'backend');

const sheets = {};
const mails = [];
function mkSheet() {
  const data = [];
  const pad = (r, c) => { while (data.length < r) data.push([]); data.forEach(row => { while (row.length < c) row.push(''); }); };
  return {
    data,
    getDataRange: () => ({ getValues: () => data.map(r => r.slice()) }),
    getLastRow: () => data.length,
    setFrozenRows() {},
    appendRow(r) { data.push(r.slice()); },
    deleteRow(r) { data.splice(r - 1, 1); },
    getRange(r, c, nr = 1, nc = 1) {
      return {
        setValues(v) { pad(r + nr - 1, c + nc - 1); for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) data[r - 1 + i][c - 1 + j] = v[i][j]; return this; },
        setValue(v) { pad(r, c); data[r - 1][c - 1] = v; return this; },
        clearContent() { pad(r + nr - 1, c + nc - 1); for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) data[r - 1 + i][c - 1 + j] = ''; return this; },
        setFontWeight() { return this; }
      };
    }
  };
}
const ss = {
  getSheetByName: n => sheets[n] || null,
  insertSheet: n => (sheets[n] = mkSheet()),
  getSheets: () => Object.values(sheets),
  setSpreadsheetTimeZone() {}, getSpreadsheetTimeZone: () => 'America/New_York',
  toast() {}, deleteSheet() {}
};
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'prof@gmail.com' }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
  Utilities: { formatDate: d => d.toISOString(), parseCsv: t => t.trim().split(/\r?\n/).map(l => l.split(',')) },
  MailApp: { sendEmail: (to, subject) => mails.push({ to, subject }) },
  console
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(dir, 'Seed.js'), 'utf8') + '\n' + fs.readFileSync(path.join(dir, 'Code.js'), 'utf8') +
  '\nthis.api = {setup, importRoster, handle_};', ctx);
const api = ctx.api;

let pass = 0, fail = 0;
const ok = (cond, label) => { cond ? pass++ : (fail++, console.log('FAIL:', label)); };
const throws = (fn, re, label) => { try { fn(); ok(false, label + ' (no error)'); } catch (e) { ok(re.test(e.message), label + ' -> ' + e.message); } };
const m = u => u + '@x.edu';
const act = (u, action, ...args) => api.handle_(m(u), action, args, '');
const state = u => act(u, 'state');
const setting = (name, value) => { sheets.Settings.data.find(r => r[0] === name)[1] = value; };
const groupRow = name => sheets.Groups.data.find(r => r[0] === name);

api.setup();
ok(sheets.Datasets.data.length === 20 && sheets.Topics.data.length === 26 && sheets.Groups.data.length === 1, 'setup sizes');
api.importRoster('Email,Last Name,First Name\n' + 'abcdefgh'.split('').map(c => `${c.toUpperCase()}@x.edu,L${c},F${c}`).join('\n'));
ok(sheets.Roster.data.length === 9 && sheets.Roster.data[1][2] === 'a@x.edu', 'roster import, emails lowercased');

// access
ok(state('stranger').authorized === false, 'stranger blocked');
throws(() => act('stranger', 'createGroup'), /not on the class roster/, 'stranger cannot act');
let s = api.handle_('prof@gmail.com', 'state', [], '');
ok(s.authorized && s.admin && s.me === null && s.roster.length === 8, 'instructor read-only view');
ok(state('a').roster === null && state('a').groups.length === 0, 'student has no roster list, no groups yet');

// create, request, approve
throws(() => act('a', 'claimTopic', 1), /Create or join a group/, 'claim without a group');
s = act('a', 'createGroup');
ok(s.me.group === 'Group 1' && s.me.leader && s.groups.length === 1, 'create group');
throws(() => act('a', 'createGroup'), /Leave it before/, 'cannot create a second group');
throws(() => act('a', 'claimTopic', 1), /at least 2 members/, 'solo leader cannot claim');
throws(() => act('a', 'requestJoin', 'Group 1'), /Leave it before/, 'member cannot request');
s = act('b', 'requestJoin', 'Group 1');
ok(s.me.request === 'Group 1' && s.me.group === '' && s.requests.length === 0, 'request pending, no direct join');
ok(mails.length === 1 && mails[0].to === 'a@x.edu', 'leader emailed');
ok(state('a').requests.length === 1 && state('a').requests[0].email === 'b@x.edu', 'leader sees the request');
throws(() => act('c', 'decideRequest', m('b'), true), /Only the group leader/, 'non-member cannot approve');
s = act('a', 'decideRequest', m('b'), true);
ok(s.groups[0].members.length === 2 && s.requests.length === 0 && state('b').me.group === 'Group 1', 'approve adds member');
throws(() => act('b', 'claimTopic', 1), /Only the group leader/, 'member cannot claim');
throws(() => act('b', 'decideRequest', m('c'), true), /Only the group leader/, 'member cannot approve');

// claims
throws(() => act('a', 'claimDataset', 0), /reserved/, 'dataset 0 reserved');
s = act('a', 'claimDataset', '3');
ok(s.groups[0].dataset === '3' && s.datasets[3].claimedBy[0] === 'Group 1', 'dataset claim');
act('a', 'claimTopic', 5);
act('c', 'createGroup'); act('d', 'requestJoin', 'Group 2'); act('c', 'decideRequest', m('d'), true);
throws(() => act('c', 'claimDataset', 3), /just claimed by Group 1/, 'second claim of a dataset rejected');
throws(() => act('c', 'claimTopic', 5), /just claimed by Group 1/, 'second claim of a topic rejected');
act('a', 'claimDataset', 4);
s = act('c', 'claimDataset', 3);
ok(s.datasets[3].claimedBy[0] === 'Group 2' && s.datasets[4].claimedBy[0] === 'Group 1', 'switch releases old dataset');
throws(() => act('c', 'claimDataset', 18, ''), /full web link/, 'own choice needs a link');
act('a', 'claimDataset', 18, 'https://www.kaggle.com/datasets/x/y');
s = act('c', 'claimDataset', 18, 'https://www.kaggle.com/datasets/z/w');
ok(s.datasets[18].claimedBy.length === 2 && s.datasets[3].claimedBy.length === 0, 'own choice shared by two groups');

// capacity 3: third member fills the group, other requests are closed
act('e', 'requestJoin', 'Group 1'); act('f', 'requestJoin', 'Group 1');
act('a', 'decideRequest', m('e'), true);
ok(state('a').groups[0].full && state('f').me.request === '' && state('a').requests.length === 0, 'full group closes remaining requests');
throws(() => act('f', 'requestJoin', 'Group 1'), /full/, 'cannot request a full group');

// decline, cancel, replace request
act('f', 'requestJoin', 'Group 2');
act('c', 'decideRequest', m('f'), false);
ok(state('f').me.request === '' && state('f').me.group === '', 'decline');
throws(() => act('c', 'decideRequest', m('f'), true), /no longer pending/, 'decided request cannot be reused');
act('f', 'requestJoin', 'Group 2'); act('f', 'cancelRequest');
ok(state('c').requests.length === 0, 'cancel request');
act('f', 'requestJoin', 'Group 2'); s = act('f', 'createGroup');
ok(s.me.group === 'Group 3' && state('c').requests.length === 0, 'creating a group cancels the pending request');
act('g', 'requestJoin', 'Group 2'); act('g', 'requestJoin', 'Group 3');
ok(state('c').requests.length === 0 && state('f').requests.length === 1, 'new request replaces the old one');

// remove member, leave, leadership
throws(() => act('b', 'removeMember', m('e')), /Only the group leader/, 'member cannot remove');
s = act('a', 'removeMember', m('e'));
ok(s.groups[0].members.length === 2 && state('e').me.group === '', 'leader removes a member');
s = act('a', 'leaveGroup');
ok(groupRow('Group 1')[1] === 'b@x.edu' && String(groupRow('Group 1')[6]) === '5', 'leader leaves: next member leads, claims kept');
throws(() => act('b', 'claimTopic', 6), /at least 2 members/, 'group below minimum cannot change claims');
act('b', 'leaveGroup');
ok(!groupRow('Group 1') && state('c').topics[4].claimedBy.length === 0, 'empty group deleted, claims released');
act('g', 'cancelRequest'); act('g', 'requestJoin', 'Group 3'); act('f', 'leaveGroup');
ok(!groupRow('Group 3') && state('g').me.request === '', 'deleting a group closes its requests');
s = act('a', 'createGroup');
ok(s.me.group === 'Group 1', 'freed group number is reused');

// cap on number of groups, hidden from students
setting('Maximum number of groups', 2);
ok(state('b').canCreate === false, 'canCreate false at the cap');
throws(() => act('b', 'createGroup'), /No new group/, 'cap on groups');
setting('Maximum number of groups', 20);

const lastLog = sheets.Log.data[sheets.Log.data.length - 1];
ok(lastLog[1] === 'b@x.edu' && lastLog[2] === 'refused: createGroup' && /No new group/.test(lastLog[3]), 'refused attempts are logged');

// preview: instructors only, no emails
const before = mails.length;
s = api.handle_('prof@gmail.com', 'requestJoin', ['Group 1'], m('b'));
ok(s.preview && s.me.request === 'Group 1' && mails.length === before, 'instructor acts as student without emails');
ok(/preview by prof/.test(sheets.Log.data[sheets.Log.data.length - 1][1]), 'preview logged');
s = api.handle_(m('e'), 'state', [], m('b'));
ok(!s.preview && s.email === 'e@x.edu', 'student cannot preview as another student');
throws(() => api.handle_('prof@gmail.com', 'createGroup', [], ''), /not on the class roster/, 'instructor cannot act as self');

// emails off
setting('Email notifications', 'no');
act('e', 'requestJoin', 'Group 2');
ok(mails.length === before, 'notifications can be disabled');

// deadline
setting('Deadline', new Date(Date.now() - 1000));
throws(() => act('c', 'claimTopic', 7), /deadline has passed/, 'deadline blocks claims');
throws(() => act('c', 'decideRequest', m('e'), true), /deadline has passed/, 'deadline blocks approvals');
ok(state('c').closed === true, 'state reports closed');
setting('Deadline', new Date(Date.now() + 1e6));
s = act('c', 'claimTopic', 7);
ok(s.closed === false && s.groups.find(g => g.name === 'Group 2').topic === '7', 'future deadline allows changes');
ok(!JSON.stringify(s).includes('"_row"') && s.groups.find(g => g.name === 'Group 1').members[0].email === '', 'state is plain, other groups carry no emails');

console.log('passed', pass, 'failed', fail);
process.exit(fail ? 1 : 0);
