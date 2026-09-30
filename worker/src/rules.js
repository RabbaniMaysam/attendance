/**
 * Group, dataset, and topic sign-up tool: the rules.
 * Pure functions over one class's state object. No storage and no network here,
 * so the same code is exercised by test/test_rules.mjs and by the Worker.
 *
 * State of a class:
 *   settings {title, deadline (ISO text or ''), maxSize, minToClaim, maxGroups}
 *   roster   [{first, last, email, group, joinedAt}]
 *   groups   [{name, leader, createdAt, dataset, ownLink, datasetAt, datasetBy, groupDataset, groupOwnLink, topic, topicAt, topicBy, groupTopic}]
 *            datasetBy/topicBy: 'group' when the leader claimed it, 'instructor' when set on the instructor page.
 *            An item set by the instructor is locked: the group cannot switch or release it until the instructor undoes it.
 *            groupDataset/groupOwnLink/groupTopic: what the group itself claimed last, kept when the instructor overrides it
 *            so the undo can restore it.
 *   requests [{time, email, group, status, decidedAt}]
 *   datasets [{code, name, link, own, reserved}]
 *   topics   [{code, topic, description}]
 */

export const TZ = 'America/New_York';

const norm = s => String(s ?? '').trim().toLowerCase();
const text = s => String(s ?? '').trim();
/** One spelling per student: Montclair's @mail.montclair.edu addresses are the same accounts as @montclair.edu. */
export const canonEmail = s => norm(s).replace(/@mail\.montclair\.edu$/, '@montclair.edu');
const fullName = r => (r.first + ' ' + r.last).trim();
const num = (v, fallback) => { const n = Math.floor(Number(v)); return n > 0 ? n : fallback; };
const byCode = (a, b) => (Number(a.code) - Number(b.code)) || String(a.code).localeCompare(String(b.code));

export function newClass(title, seedDatasets, seedTopics) {
  return {
    settings: { title: title, deadline: '', maxSize: 3, minToClaim: 2, maxGroups: 20 },
    roster: [], groups: [], requests: [],
    datasets: seedDatasets.map(d => ({ code: String(d[0]), name: d[1], link: d[2], own: /^y/i.test(d[3]), reserved: d[4] })),
    topics: seedTopics.map(t => ({ code: String(t[0]), topic: t[1], description: t[2] }))
  };
}

export function isClosed(s, now) {
  const d = Date.parse(s.settings.deadline);
  return !isNaN(d) && now > d;
}

// ---------------------------------------------------------------- shared pieces

const group = (s, name) => s.groups.find(g => g.name === String(name));
const members = (s, name) => s.roster.filter(r => r.group === String(name));
const student = (s, email) => s.roster.find(r => r.email === canonEmail(email));

function setMember(st, name, now) {
  st.group = name;
  st.joinedAt = name ? now : '';
}

/** Marks the pending requests that satisfy test with the given status. Returns how many. */
function closeRequests(s, test, status, now) {
  let n = 0;
  s.requests.forEach(q => {
    if (q.status !== 'pending' || !test(q)) return;
    q.status = status;
    q.decidedAt = now;
    n++;
  });
  return n;
}

function newGroup(s, leader, now) {
  let n = 1;
  while (group(s, 'Group ' + n)) n++;
  const name = 'Group ' + n;
  s.groups.push({ name: name, leader: leader.email, createdAt: now, dataset: '', ownLink: '', datasetAt: '', datasetBy: '', groupDataset: '', groupOwnLink: '',
                 topic: '', topicAt: '', topicBy: '', groupTopic: '' });
  setMember(leader, name, now);
  return name;
}

/**
 * Takes a student out of their group. A leader is replaced by the member who
 * joined earliest. A group whose last member is gone is deleted, which
 * releases its dataset and topic.
 */
function detach(s, st, now, log) {
  const name = st.group;
  if (!name) return;
  const g = group(s, name);
  setMember(st, '', now);
  if (!g) return;
  const others = members(s, name).sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1 : 0));
  if (!others.length) {
    closeRequests(s, q => q.group === name, 'declined (group closed)', now);
    s.groups.splice(s.groups.indexOf(g), 1);
    log('delete group', name + ' became empty; its claims are released');
  } else if (g.leader === st.email) {
    g.leader = others[0].email;
    log('new leader', name + ': ' + g.leader);
  }
}

function leaderGroup(c) {
  const g = group(c.s, c.me.group);
  if (!g || g.leader !== c.email) throw new Error('Only the group leader can do this.');
  return g;
}

function claimingGroup(c) {
  if (!c.me.group) throw new Error('Create or join a group first.');
  const g = leaderGroup(c);
  const min = num(c.s.settings.minToClaim, 2);
  if (members(c.s, g.name).length < min) {
    throw new Error('Your group needs at least ' + min + ' members before it can claim a dataset or topic.');
  }
  return g;
}

/** An item the instructor set stays fixed until the instructor undoes it. */
function locked(g, kind) {
  if (g[kind + 'By'] === 'instructor') {
    throw new Error('Your instructor set this ' + kind + ' for your group. Only the instructor can change it.');
  }
}

// ---------------------------------------------------------------- student actions

const ACTIONS = {
  createGroup(c) {
    if (c.me.group) throw new Error('You are in ' + c.me.group + '. Leave it before creating a new group.');
    if (c.s.groups.length >= num(c.s.settings.maxGroups, 20)) {
      throw new Error('No new group can be created now. Ask to join an existing group.');
    }
    const name = newGroup(c.s, c.me, c.now);
    closeRequests(c.s, q => q.email === c.email, 'cancelled', c.now);
    c.log('create group', name);
  },

  requestJoin(c, groupName) {
    if (c.me.group) throw new Error('You are in ' + c.me.group + '. Leave it before asking to join another group.');
    const g = group(c.s, groupName);
    if (!g) throw new Error('That group no longer exists.');
    if (members(c.s, g.name).length >= num(c.s.settings.maxSize, 3)) throw new Error(g.name + ' is full.');
    closeRequests(c.s, q => q.email === c.email, 'cancelled', c.now);
    c.s.requests.push({ time: c.now, email: c.email, group: g.name, status: 'pending', decidedAt: '' });
    c.log('request to join', g.name);
  },

  cancelRequest(c) {
    if (closeRequests(c.s, q => q.email === c.email, 'cancelled', c.now)) c.log('cancel request', '');
  },

  decideRequest(c, requesterEmail, approve) {
    const g = leaderGroup(c);
    const who = canonEmail(requesterEmail);
    const mine = q => q.email === who && q.group === g.name;
    if (!c.s.requests.some(q => q.status === 'pending' && mine(q))) throw new Error('That request is no longer pending.');
    if (!approve) {
      closeRequests(c.s, mine, 'declined', c.now);
      c.log('decline request', who + ' -> ' + g.name);
      return;
    }
    const st = student(c.s, who);
    if (!st || st.group) throw new Error(st ? fullName(st) + ' has joined another group.' : 'That student is no longer on the roster.');
    const maxSize = num(c.s.settings.maxSize, 3);
    const size = members(c.s, g.name).length;
    if (size >= maxSize) throw new Error(g.name + ' is full. Remove a member or decline the request.');
    setMember(st, g.name, c.now);
    closeRequests(c.s, mine, 'approved', c.now);
    c.log('approve request', who + ' -> ' + g.name);
    if (size + 1 >= maxSize) closeRequests(c.s, q => q.group === g.name, 'declined (group full)', c.now);
  },

  removeMember(c, memberEmail) {
    const g = leaderGroup(c);
    const who = canonEmail(memberEmail);
    if (who === c.email) throw new Error('Use Leave to leave your own group.');
    const st = student(c.s, who);
    if (!st || st.group !== g.name) throw new Error('That student is not in ' + g.name + '.');
    setMember(st, '', c.now);
    c.log('remove member', who + ' from ' + g.name);
  },

  leaveGroup(c) {
    const name = c.me.group;
    if (!name) return;
    c.log('leave group', name);
    detach(c.s, c.me, c.now, c.log);
  },

  claimDataset(c, code, ownLink) {
    const g = claimingGroup(c);
    locked(g, 'dataset');
    const d = c.s.datasets.find(x => x.code === String(code));
    if (!d) throw new Error('That dataset does not exist.');
    if (d.reserved) throw new Error('"' + d.name + '" is reserved.');
    let link = '';
    if (d.own) {
      link = text(ownLink);
      if (!/^https?:\/\/\S+$/i.test(link)) throw new Error('Paste the full web link of the dataset you chose.');
    } else {
      const holder = c.s.groups.find(x => x.dataset === d.code && x !== g);
      if (holder) throw new Error('"' + d.name + '" was just claimed by ' + holder.name + '. Choose another dataset.');
    }
    g.dataset = d.code; g.ownLink = link; g.datasetAt = c.now; g.datasetBy = 'group'; g.groupDataset = d.code; g.groupOwnLink = link;
    c.log('claim dataset', g.name + ': ' + d.code + ' ' + d.name + (link ? ' ' + link : ''));
  },

  claimTopic(c, code) {
    const g = claimingGroup(c);
    locked(g, 'topic');
    const t = c.s.topics.find(x => x.code === String(code));
    if (!t) throw new Error('That topic does not exist.');
    const holder = c.s.groups.find(x => x.topic === t.code && x !== g);
    if (holder) throw new Error('"' + t.topic + '" was just claimed by ' + holder.name + '. Choose another topic.');
    g.topic = t.code; g.topicAt = c.now; g.topicBy = 'group'; g.groupTopic = t.code;
    c.log('claim topic', g.name + ': ' + t.code + ' ' + t.topic);
  },

  // Releasing frees the item for any group. It lets two groups swap items when everything is taken.
  releaseDataset(c) {
    const g = claimingGroup(c);
    locked(g, 'dataset');
    if (g.dataset === '') return;
    const d = c.s.datasets.find(x => x.code === g.dataset);
    c.log('release dataset', g.name + ': ' + g.dataset + ' ' + (d ? d.name : ''));
    g.dataset = ''; g.ownLink = ''; g.datasetAt = ''; g.datasetBy = ''; g.groupDataset = ''; g.groupOwnLink = '';
  },

  releaseTopic(c) {
    const g = claimingGroup(c);
    locked(g, 'topic');
    if (g.topic === '') return;
    const t = c.s.topics.find(x => x.code === g.topic);
    c.log('release topic', g.name + ': ' + g.topic + ' ' + (t ? t.topic : ''));
    g.topic = ''; g.topicAt = ''; g.topicBy = ''; g.groupTopic = '';
  }
};

/** Fills in fields added after a class was created, so older stored states read like new ones. */
export function upgrade(s) {
  s.groups.forEach(g => {
    ['dataset', 'topic'].forEach(k => {
      if (g[k + 'By'] === undefined) g[k + 'By'] = g[k] ? 'group' : '';
      const own = 'group' + k.charAt(0).toUpperCase() + k.slice(1);
      if (g[own] === undefined) g[own] = g[k + 'By'] === 'group' ? g[k] : '';
    });
    if (g.groupOwnLink === undefined) g.groupOwnLink = g.datasetBy === 'group' ? g.ownLink : '';
  });
  return s;
}

/** The account a request acts for. Only an instructor may act for another roster email. */
const acting = (real, viewAs, admin) => (admin && canonEmail(viewAs) ? canonEmail(viewAs) : real);

/**
 * Applies one student action to the state in place and returns its log lines.
 * Throws with a message for the student when the action is refused; the caller
 * must then discard the state object.
 */
export function act(s, real, action, args, viewAs, admin, nowMs) {
  const fn = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!fn) throw new Error('Unknown action.');
  const email = acting(real, viewAs, admin);
  const me = student(s, email);
  if (!email || !me) throw new Error('This account is not on the class roster.');
  if (isClosed(s, nowMs)) throw new Error('The sign-up deadline has passed. Contact your instructor for changes.');
  const logs = [];
  const actor = email === real ? email : email + ' (preview by ' + real + ')';
  const c = { s: s, email: email, me: me, now: new Date(nowMs).toISOString(),
              log: (a, detail) => logs.push({ actor: actor, action: a, detail: detail }) };
  fn(c, ...args);
  return logs;
}

/** Everything the student page displays. */
export function view(s, real, viewAs, admin, nowMs) {
  const email = acting(real, viewAs, admin);
  const me = student(s, email);
  if (!email || (!me && !admin)) return { authorized: false, email: email };

  const nameOf = mail => { const r = student(s, mail); return r ? fullName(r) : String(mail); };
  const maxSize = num(s.settings.maxSize, 3);
  const pending = s.requests.filter(q => q.status === 'pending');
  const myGroup = me ? me.group : '';
  const g0 = group(s, myGroup);
  const leading = !!g0 && g0.leader === email;
  const myRequest = pending.find(q => q.email === email);
  const deadline = Date.parse(s.settings.deadline);

  return {
    authorized: true,
    admin: admin,
    email: email,
    preview: email !== real,
    // Instructors receive the roster so the page can offer "preview as student".
    roster: admin ? s.roster.map(r => ({ email: r.email, name: fullName(r) })) : null,
    me: me ? { name: fullName(me), group: myGroup, leader: leading, request: myRequest ? myRequest.group : '' } : null,
    // Requests waiting for this student's decision (group leaders only).
    requests: leading
      ? pending.filter(q => q.group === myGroup).map(q => ({ email: q.email, name: nameOf(q.email) }))
      : [],
    title: s.settings.title,
    deadlineText: isNaN(deadline) ? '' : new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(deadline),
    closed: isClosed(s, nowMs),
    maxSize: maxSize,
    minToClaim: num(s.settings.minToClaim, 2),
    canCreate: s.groups.length < num(s.settings.maxGroups, 20),
    groups: s.groups.map(g => {
      const ms = members(s, g.name);
      return {
        name: g.name,
        leader: nameOf(g.leader),
        // Emails are included only for the leader's own group, to remove a member.
        members: ms.map(r => ({ name: fullName(r), email: leading && g.name === myGroup ? r.email : '' })),
        full: ms.length >= maxSize,
        dataset: g.dataset,
        ownLink: g.ownLink,
        datasetBy: g.datasetBy || '',
        topic: g.topic,
        topicBy: g.topicBy || ''
      };
    }),
    datasets: s.datasets.map(d => ({
      code: d.code, name: d.name, link: d.link, own: d.own, reserved: d.reserved,
      claimedBy: s.groups.filter(g => g.dataset === d.code).map(g => g.name)
    })),
    topics: s.topics.map(t => ({
      code: t.code, topic: t.topic, description: t.description,
      claimedBy: s.groups.filter(g => g.topic === t.code).map(g => g.name)
    }))
  };
}

// ---------------------------------------------------------------- instructor actions

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

function dropStudent(c, st) {
  detach(c.s, st, c.now, c.log);
  closeRequests(c.s, q => q.email === st.email, 'cancelled', c.now);
}

const ADMIN = {
  saveSettings(c, v) {
    const title = text(v && v.title);
    if (!title) throw new Error('The course title is empty.');
    let deadline = '';
    if (text(v.deadline)) {
      const d = Date.parse(v.deadline);
      if (isNaN(d)) throw new Error('The deadline is not a valid date and time.');
      deadline = new Date(d).toISOString();
    }
    c.s.settings = { title: title, deadline: deadline, maxSize: num(v.maxSize, 3),
                     minToClaim: num(v.minToClaim, 2), maxGroups: num(v.maxGroups, 20) };
    c.log('save settings', JSON.stringify(c.s.settings));
  },

  /** Replaces the roster with the CSV (layouts: see parseRoster). Students who remain keep their group. */
  importRoster(c, csv) {
    const seen = {};
    const out = parseRoster(csv).map(st => {
      seen[st.email] = true;
      const prev = student(c.s, st.email);
      return { first: st.first, last: st.last, email: st.email,
               group: prev ? prev.group : '', joinedAt: prev ? prev.joinedAt : '' };
    });
    const dropped = c.s.roster.filter(r => !seen[r.email]);
    dropped.forEach(st => dropStudent(c, st));
    // A dropped leader may have been replaced above, so group fields are read again.
    out.forEach(r => { const prev = student(c.s, r.email); if (prev) { r.group = prev.group; r.joinedAt = prev.joinedAt; } });
    c.s.roster = out;
    c.log('import roster', out.length + ' students, ' + dropped.length + ' removed');
  },

  addStudent(c, first, last, email) {
    const mail = canonEmail(email);
    if (!/^\S+@\S+\.\S+$/.test(mail)) throw new Error('That email address is not valid.');
    if (student(c.s, mail)) throw new Error(mail + ' is on the roster.');
    c.s.roster.push({ first: text(first), last: text(last), email: mail, group: '', joinedAt: '' });
    c.log('add student', mail);
  },

  removeStudent(c, email) {
    const st = student(c.s, email);
    if (!st) throw new Error('That student is not on the roster.');
    dropStudent(c, st);
    c.s.roster.splice(c.s.roster.indexOf(st), 1);
    c.log('remove student', st.email);
  },

  /** target: '' = no group, 'new' = a new group led by the student, or a group name. Size limits do not bind the instructor. */
  moveStudent(c, email, target) {
    const st = student(c.s, email);
    if (!st) throw new Error('That student is not on the roster.');
    target = String(target || '');
    if (target && target !== 'new' && !group(c.s, target)) throw new Error('That group does not exist.');
    if (st.group === target) return;
    dropStudent(c, st);
    if (target === 'new') target = newGroup(c.s, st, c.now);
    else if (target) {
      if (!group(c.s, target)) throw new Error(target + ' had no other member and was deleted. Choose "New group".');
      setMember(st, target, c.now);
      if (members(c.s, target).length >= num(c.s.settings.maxSize, 3)) {
        closeRequests(c.s, q => q.group === target, 'declined (group full)', c.now);
      }
    }
    c.log('move student', st.email + ' -> ' + (target || 'no group'));
  },

  setLeader(c, groupName, email) {
    const g = group(c.s, groupName);
    const st = student(c.s, email);
    if (!g || !st || st.group !== g.name) throw new Error('The leader must be a member of the group.');
    g.leader = st.email;
    c.log('set leader', g.name + ': ' + st.email);
  },

  /** kind: 'dataset' or 'topic'. An empty code releases the claim. */
  setClaim(c, groupName, kind, code, ownLink) {
    const g = group(c.s, groupName);
    if (!g) throw new Error('That group does not exist.');
    code = text(code);
    if (kind === 'dataset') {
      const d = c.s.datasets.find(x => x.code === code);
      if (code && !d) throw new Error('That dataset does not exist.');
      const holder = d && !d.own && c.s.groups.find(x => x.dataset === code && x !== g);
      if (holder) throw new Error('"' + d.name + '" is claimed by ' + holder.name + '. Release it there first.');
      if (code === g.dataset && (d && d.own ? text(ownLink) : '') === g.ownLink) return;
      g.dataset = code; g.ownLink = d && d.own ? text(ownLink) : ''; g.datasetAt = code ? c.now : '';
      g.datasetBy = code ? 'instructor' : '';
    } else if (kind === 'topic') {
      const t = c.s.topics.find(x => x.code === code);
      if (code && !t) throw new Error('That topic does not exist.');
      const holder = t && c.s.groups.find(x => x.topic === code && x !== g);
      if (holder) throw new Error('"' + t.topic + '" is claimed by ' + holder.name + '. Release it there first.');
      if (code === g.topic) return;
      g.topic = code; g.topicAt = code ? c.now : '';
      g.topicBy = code ? 'instructor' : '';
    } else throw new Error('Unknown claim type.');
    c.log('set ' + kind, g.name + ': ' + (code || 'released') + (kind === 'dataset' && g.ownLink ? ' ' + g.ownLink : ''));
  },

  /** Takes back the instructor's choice: the group's own earlier choice returns and the group may change it again. */
  undoClaim(c, groupName, kind) {
    const g = group(c.s, groupName);
    if (!g) throw new Error('That group does not exist.');
    if (kind !== 'dataset' && kind !== 'topic') throw new Error('Unknown claim type.');
    if (g[kind + 'By'] !== 'instructor') return;
    const own = kind === 'dataset' ? g.groupDataset : g.groupTopic;
    if (kind === 'dataset') {
      const d = c.s.datasets.find(x => x.code === own);
      const holder = d && !d.own && c.s.groups.find(x => x.dataset === own && x !== g);
      if (holder) throw new Error('The group\'s own dataset "' + d.name + '" is now claimed by ' + holder.name + '. Release it there first.');
      g.dataset = d ? own : ''; g.ownLink = d ? g.groupOwnLink : ''; g.datasetAt = d ? c.now : '';
      g.datasetBy = d ? 'group' : ''; g.groupDataset = d ? own : ''; g.groupOwnLink = d ? g.groupOwnLink : '';
    } else {
      const t = c.s.topics.find(x => x.code === own);
      const holder = t && c.s.groups.find(x => x.topic === own && x !== g);
      if (holder) throw new Error('The group\'s own topic "' + t.topic + '" is now claimed by ' + holder.name + '. Release it there first.');
      g.topic = t ? own : ''; g.topicAt = t ? c.now : ''; g.topicBy = t ? 'group' : ''; g.groupTopic = t ? own : '';
    }
    c.log('undo set ' + kind, g.name + ': back to ' + (g[kind] || 'none'));
  },

  deleteGroup(c, groupName) {
    const g = group(c.s, groupName);
    if (!g) throw new Error('That group does not exist.');
    members(c.s, g.name).forEach(st => setMember(st, '', c.now));
    closeRequests(c.s, q => q.group === g.name, 'declined (group closed)', c.now);
    c.s.groups.splice(c.s.groups.indexOf(g), 1);
    c.log('delete group', g.name);
  },

  saveDataset(c, v) {
    const code = text(v && v.code);
    if (!code || !text(v.name)) throw new Error('A dataset needs a code and a name.');
    const item = { code: code, name: text(v.name), link: text(v.link), own: !!v.own, reserved: text(v.reserved) };
    const i = c.s.datasets.findIndex(x => x.code === code);
    if (i < 0) c.s.datasets.push(item); else c.s.datasets[i] = item;
    c.s.datasets.sort(byCode);
    c.log('save dataset', code + ' ' + item.name);
  },

  removeDataset(c, code) {
    code = text(code);
    const holder = c.s.groups.find(g => g.dataset === code);
    if (holder) throw new Error('That dataset is claimed by ' + holder.name + '. Release it first.');
    c.s.datasets = c.s.datasets.filter(x => x.code !== code);
    c.log('remove dataset', code);
  },

  saveTopic(c, v) {
    const code = text(v && v.code);
    if (!code || !text(v.topic)) throw new Error('A topic needs a code and a title.');
    const item = { code: code, topic: text(v.topic), description: text(v.description) };
    const i = c.s.topics.findIndex(x => x.code === code);
    if (i < 0) c.s.topics.push(item); else c.s.topics[i] = item;
    c.s.topics.sort(byCode);
    c.log('save topic', code + ' ' + item.topic);
  },

  removeTopic(c, code) {
    code = text(code);
    const holder = c.s.groups.find(g => g.topic === code);
    if (holder) throw new Error('That topic is claimed by ' + holder.name + '. Release it first.');
    c.s.topics = c.s.topics.filter(x => x.code !== code);
    c.log('remove topic', code);
  }
};

export const isAdminAction = action => Object.prototype.hasOwnProperty.call(ADMIN, action);

/** Applies one instructor action in place and returns its log lines. The deadline does not bind the instructor. */
export function adminAct(s, real, action, args, nowMs) {
  if (!isAdminAction(action)) throw new Error('Unknown action.');
  const logs = [];
  const c = { s: s, now: new Date(nowMs).toISOString(),
              log: (a, detail) => logs.push({ actor: real + ' (instructor)', action: a, detail: detail }) };
  ADMIN[action](c, ...args);
  return logs;
}
