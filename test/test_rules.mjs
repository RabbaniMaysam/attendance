// Tests the sign-up rules (worker/src/rules.js) on an in-memory class.
// Run from the repository root:  node test/test_rules.mjs
import { act, view, adminAct, newClass } from '../worker/src/rules.js';
import { SEED_DATASETS, SEED_TOPICS } from '../worker/src/seed.js';

const PROF = 'prof@gmail.com';
let S = newClass('Test class', SEED_DATASETS, SEED_TOPICS);
const logs = [];
let pass = 0, fail = 0;
const ok = (cond, label) => { cond ? pass++ : (fail++, console.log('FAIL:', label)); };
const throws = (fn, re, label) => { try { fn(); ok(false, label + ' (no error)'); } catch (e) { ok(re.test(e.message), label + ' -> ' + e.message); } };
const m = u => u + '@x.edu';

// Like the Worker: a refused action changes nothing.
function run(real, action, args, viewAs, admin) {
  const copy = structuredClone(S);
  logs.push(...act(copy, real, action, args, viewAs, admin, Date.now()));
  S = copy;
  return view(S, real, viewAs, admin, Date.now());
}
const act1 = (u, action, ...args) => run(m(u), action, args, '', false);
const state = u => view(S, m(u), '', false, Date.now());
const adm = (action, ...args) => { const copy = structuredClone(S); logs.push(...adminAct(copy, PROF, action, args, Date.now())); S = copy; };
const grp = name => S.groups.find(g => g.name === name);

ok(S.datasets.length === 19 && S.topics.length === 25 && S.datasets[18].own === true && S.datasets[0].reserved !== '', 'seed catalog');
adm('importRoster', 'Email,Last Name,First Name\n' + 'abcdefgh'.split('').map(c => `${c.toUpperCase()}@x.edu,"L${c}",F${c}`).join('\r\n'));
ok(S.roster.length === 8 && S.roster[0].email === 'a@x.edu' && S.roster[0].first === 'Fa', 'roster import, emails lowercased');

// access
ok(state('stranger').authorized === false, 'stranger blocked');
throws(() => act1('stranger', 'createGroup'), /not on the class roster/, 'stranger cannot act');
let s = view(S, PROF, '', true, Date.now());
ok(s.authorized && s.admin && s.me === null && s.roster.length === 8, 'instructor read-only view');
ok(state('a').roster === null && state('a').groups.length === 0, 'student has no roster list, no groups yet');
throws(() => act1('a', 'constructor'), /Unknown action/, 'unknown action refused');

// create, request, approve
throws(() => act1('a', 'claimTopic', 1), /Create or join a group/, 'claim without a group');
s = act1('a', 'createGroup');
ok(s.me.group === 'Group 1' && s.me.leader && s.groups.length === 1, 'create group');
throws(() => act1('a', 'createGroup'), /Leave it before/, 'cannot create a second group');
throws(() => act1('a', 'claimTopic', 1), /at least 2 members/, 'solo leader cannot claim');
throws(() => act1('a', 'requestJoin', 'Group 1'), /Leave it before/, 'member cannot request');
s = act1('b', 'requestJoin', 'Group 1');
ok(s.me.request === 'Group 1' && s.me.group === '' && s.requests.length === 0, 'request pending, no direct join');
ok(state('a').requests.length === 1 && state('a').requests[0].email === 'b@x.edu', 'leader sees the request');
throws(() => act1('c', 'decideRequest', m('b'), true), /Only the group leader/, 'non-member cannot approve');
s = act1('a', 'decideRequest', m('b'), true);
ok(s.groups[0].members.length === 2 && s.requests.length === 0 && state('b').me.group === 'Group 1', 'approve adds member');
throws(() => act1('b', 'claimTopic', 1), /Only the group leader/, 'member cannot claim');
throws(() => act1('b', 'decideRequest', m('c'), true), /Only the group leader/, 'member cannot approve');

// claims
throws(() => act1('a', 'claimDataset', 0), /reserved/, 'dataset 0 reserved');
s = act1('a', 'claimDataset', '3');
ok(s.groups[0].dataset === '3' && s.datasets[3].claimedBy[0] === 'Group 1', 'dataset claim');
act1('a', 'claimTopic', 5);
act1('c', 'createGroup'); act1('d', 'requestJoin', 'Group 2'); act1('c', 'decideRequest', m('d'), true);
throws(() => act1('c', 'claimDataset', 3), /just claimed by Group 1/, 'second claim of a dataset rejected');
throws(() => act1('c', 'claimTopic', 5), /just claimed by Group 1/, 'second claim of a topic rejected');
act1('a', 'claimDataset', 4);
s = act1('c', 'claimDataset', 3);
ok(s.datasets[3].claimedBy[0] === 'Group 2' && s.datasets[4].claimedBy[0] === 'Group 1', 'switch releases old dataset');
throws(() => act1('c', 'claimDataset', 18, ''), /full web link/, 'own choice needs a link');
act1('a', 'claimDataset', 18, 'https://www.kaggle.com/datasets/x/y');
s = act1('c', 'claimDataset', 18, 'https://www.kaggle.com/datasets/z/w');
ok(s.datasets[18].claimedBy.length === 2 && s.datasets[3].claimedBy.length === 0, 'own choice shared by two groups');

// capacity 3: third member fills the group, other requests are closed
act1('e', 'requestJoin', 'Group 1'); act1('f', 'requestJoin', 'Group 1');
act1('a', 'decideRequest', m('e'), true);
ok(state('a').groups[0].full && state('f').me.request === '' && state('a').requests.length === 0, 'full group closes remaining requests');
throws(() => act1('f', 'requestJoin', 'Group 1'), /full/, 'cannot request a full group');

// decline, cancel, replace request
act1('f', 'requestJoin', 'Group 2');
act1('c', 'decideRequest', m('f'), false);
ok(state('f').me.request === '' && state('f').me.group === '', 'decline');
throws(() => act1('c', 'decideRequest', m('f'), true), /no longer pending/, 'decided request cannot be reused');
act1('f', 'requestJoin', 'Group 2'); act1('f', 'cancelRequest');
ok(state('c').requests.length === 0, 'cancel request');
act1('f', 'requestJoin', 'Group 2'); s = act1('f', 'createGroup');
ok(s.me.group === 'Group 3' && state('c').requests.length === 0, 'creating a group cancels the pending request');
act1('g', 'requestJoin', 'Group 2'); act1('g', 'requestJoin', 'Group 3');
ok(state('c').requests.length === 0 && state('f').requests.length === 1, 'new request replaces the old one');

// remove member, leave, leadership
throws(() => act1('b', 'removeMember', m('e')), /Only the group leader/, 'member cannot remove');
s = act1('a', 'removeMember', m('e'));
ok(s.groups[0].members.length === 2 && state('e').me.group === '', 'leader removes a member');
act1('a', 'leaveGroup');
ok(grp('Group 1').leader === 'b@x.edu' && grp('Group 1').topic === '5', 'leader leaves: next member leads, claims kept');
throws(() => act1('b', 'claimTopic', 6), /at least 2 members/, 'group below minimum cannot change claims');
act1('b', 'leaveGroup');
ok(!grp('Group 1') && state('c').topics[4].claimedBy.length === 0, 'empty group deleted, claims released');
act1('g', 'cancelRequest'); act1('g', 'requestJoin', 'Group 3'); act1('f', 'leaveGroup');
ok(!grp('Group 3') && state('g').me.request === '', 'deleting a group closes its requests');
s = act1('a', 'createGroup');
ok(s.me.group === 'Group 1', 'freed group number is reused');

// cap on number of groups, hidden from students
adm('saveSettings', Object.assign({}, S.settings, { maxGroups: 2 }));
ok(state('b').canCreate === false, 'canCreate false at the cap');
const before = JSON.stringify(S);
throws(() => act1('b', 'createGroup'), /No new group/, 'cap on groups');
ok(JSON.stringify(S) === before, 'refused action changes nothing');
adm('saveSettings', Object.assign({}, S.settings, { maxGroups: 20 }));

// preview: instructors only
s = run(PROF, 'requestJoin', ['Group 1'], m('b'), true);
ok(s.preview && s.me.request === 'Group 1', 'instructor acts as student');
ok(/b@x\.edu \(preview by prof/.test(logs[logs.length - 1].actor), 'preview logged');
s = view(S, m('e'), m('b'), false, Date.now());
ok(!s.preview && s.email === 'e@x.edu', 'student cannot preview as another student');
throws(() => run(m('e'), 'leaveGroup', [], m('c'), false) && act1('zzz', 'x'), /Unknown action/, 'viewAs ignored for students');
ok(state('c').me.group === 'Group 2', 'student viewAs did not act for the other student');
throws(() => run(PROF, 'createGroup', [], '', true), /not on the class roster/, 'instructor cannot act as self');

act1('e', 'requestJoin', 'Group 2');

// deadline
adm('saveSettings', Object.assign({}, S.settings, { deadline: new Date(Date.now() - 1000).toISOString() }));
throws(() => act1('c', 'claimTopic', 7), /deadline has passed/, 'deadline blocks claims');
throws(() => act1('c', 'decideRequest', m('e'), true), /deadline has passed/, 'deadline blocks approvals');
ok(state('c').closed === true && /at/.test(state('c').deadlineText), 'state reports closed: ' + state('c').deadlineText);
adm('saveSettings', Object.assign({}, S.settings, { deadline: new Date(Date.now() + 1e6).toISOString() }));
s = act1('c', 'claimTopic', 7);
ok(s.closed === false && s.groups.find(g => g.name === 'Group 2').topic === '7', 'future deadline allows changes');
throws(() => act1('d', 'releaseTopic'), /Only the group leader/, 'member cannot release');
s = act1('c', 'releaseTopic');
ok(grp('Group 2').topic === '' && grp('Group 2').groupTopic === '' && s.topics.find(t => t.code === '7').claimedBy.length === 0, 'leader releases the topic');
s = act1('c', 'claimTopic', 7);
ok(s.groups.find(g => g.name === 'Group 1').members[0].email === '', 'other groups carry no emails');

// instructor actions: Group 1 = a (leader), request from b pending; Group 2 = c (leader), d; request from e pending
throws(() => adm('setClaim', 'Group 1', 'topic', '7'), /claimed by Group 2/, 'instructor cannot double-assign a topic');
const g1Before = grp('Group 1').topic;
adm('setClaim', 'Group 1', 'topic', '9');
adm('setClaim', 'Group 2', 'dataset', '');
ok(grp('Group 1').topic === '9' && grp('Group 2').dataset === '', 'instructor assigns and releases claims');
ok(grp('Group 2').topicBy === 'group' && grp('Group 1').topicBy === 'instructor' && grp('Group 2').datasetBy === '', 'claims record who set them');
ok(grp('Group 2').groupTopic === '7' && grp('Group 1').groupTopic === g1Before && grp('Group 1').topic === '9', 'the group\'s own choice survives an instructor override');
const nLogs = logs.length;
adm('setClaim', 'Group 1', 'topic', '9');
ok(logs.length === nLogs, 'unchanged instructor claim is not logged');
adm('moveStudent', m('b'), 'Group 1');
ok(state('b').me.group === 'Group 1' && state('a').requests.length === 0, 'instructor moves a student; the request is closed');
// an instructor override locks the item until the instructor undoes it
throws(() => act1('a', 'claimTopic', 10), /instructor set this topic/, 'group is locked out of switching a forced topic');
throws(() => act1('a', 'releaseTopic'), /instructor set this topic/, 'group is locked out of releasing a forced topic');
ok(grp('Group 1').topic === '9', 'the forced topic is unchanged');
adm('undoClaim', 'Group 1', 'topic');
ok(grp('Group 1').topic === '' && grp('Group 1').topicBy === '', 'undo on a group that had no topic of its own leaves it without one');
act1('a', 'claimTopic', 5);
adm('setClaim', 'Group 1', 'topic', '9');
adm('setClaim', 'Group 2', 'topic', '5');
throws(() => adm('undoClaim', 'Group 1', 'topic'), /now claimed by Group 2/, 'undo refused while the group\'s own topic is held elsewhere');
adm('undoClaim', 'Group 2', 'topic');
ok(grp('Group 2').topic === '7' && grp('Group 2').topicBy === 'group', 'undo restores the group\'s own topic');
const nUndo = logs.length;
adm('undoClaim', 'Group 2', 'topic');
ok(logs.length === nUndo, 'undo on an unforced item does nothing');
adm('undoClaim', 'Group 1', 'topic');
ok(grp('Group 1').topic === '5' && grp('Group 1').topicBy === 'group' && /undo set topic/.test(logs[logs.length - 1].action), 'undo restores Group 1 and is logged');
act1('a', 'claimTopic', 10);
ok(grp('Group 1').topicBy === 'group' && grp('Group 1').topic === '10', 'after the undo the group can claim again');
act1('a', 'claimDataset', 18, 'https://example.org/own.csv');
adm('setClaim', 'Group 1', 'dataset', '2');
throws(() => act1('a', 'claimDataset', 3), /instructor set this dataset/, 'forced dataset is locked too');
adm('undoClaim', 'Group 1', 'dataset');
ok(grp('Group 1').dataset === '18' && grp('Group 1').ownLink === 'https://example.org/own.csv' && grp('Group 1').datasetBy === 'group', 'undo restores the group\'s own dataset and its link');
adm('setClaim', 'Group 1', 'dataset', '');
ok(grp('Group 1').datasetBy === '' && grp('Group 1').groupDataset === '18', 'an instructor release does not lock the group');
act1('a', 'claimDataset', 3);
ok(grp('Group 1').dataset === '3' && grp('Group 1').groupDataset === '3', 'group claims again after an instructor release');
throws(() => adm('setLeader', 'Group 1', m('c')), /must be a member/, 'leader must be a member');
adm('setLeader', 'Group 1', m('b'));
ok(state('b').me.leader && !state('a').me.leader, 'instructor changes the leader');
adm('moveStudent', m('h'), 'new');
ok(state('h').me.group === 'Group 3' && state('h').me.leader, 'instructor starts a new group for a student');
adm('removeStudent', m('b'));
ok(grp('Group 1').leader === 'a@x.edu' && state('b').authorized === false, 'removed student loses access; leadership is reassigned');
adm('importRoster', 'first,last,email\nFc,Lc,c@x.edu\nFd,Ld,d@x.edu\nFe,Le,e@x.edu\nNew,Student,n@x.edu');
ok(S.roster.length === 4 && !grp('Group 1') && !grp('Group 3') && state('d').me.group === 'Group 2' && state('e').me.request === 'Group 2',
  're-import: dropped students leave, emptied groups are deleted, the others keep their group and requests');
throws(() => adm('removeTopic', '7'), /claimed by Group 2/, 'claimed topic cannot be removed');
adm('saveTopic', { code: '30', topic: 'New topic', description: 'x' });
adm('saveDataset', { code: '1', name: 'Diabetes (renamed)', link: '', own: false, reserved: '' });
ok(S.topics.length === 26 && S.topics[25].code === '30' && S.datasets[1].name === 'Diabetes (renamed)' && S.datasets.length === 19, 'catalog add and edit');
adm('deleteGroup', 'Group 2');
ok(S.groups.length === 0 && state('c').me.group === '' && state('e').me.request === '', 'instructor deletes a group');
ok(!JSON.stringify(logs).includes('undefined') && logs.every(l => l.actor && l.action), 'log lines are complete');

console.log('passed', pass, 'failed', fail);
process.exit(fail ? 1 : 0);
