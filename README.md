# Group sign-up

A web page where students form groups and claim one dataset and one presentation topic per group, first come, first served.

- `docs/` holds the two pages, served by GitHub Pages: `index.html` for students and `admin.html` for the instructor.
- `worker/` is the backend, a Cloudflare Worker with a D1 database.
- `test/` holds the checks (see Tests).

No student data is stored in this repository. Each class's roster, groups, claims, and activity log are in the database.

## Rules the backend enforces

- Only emails on the class roster can use the student page. Students sign in with Google.
- A student creates a new group or asks to join an existing one. The student who created the group (the leader) approves or declines each request.
- A group has at most 3 members: the leader plus up to two approved students.
- Only the leader claims the dataset and topic, and only when the group has at least 2 members.
- A claimed dataset or topic is unavailable to other groups. A leader may switch to any unclaimed item, which releases the old one.
- If the leader leaves, the member who joined earliest becomes leader. A group whose last member leaves is deleted and its claims are released.
- The number of groups is capped (20 by default). Students are not shown the cap.
- After the deadline nothing can be changed from the student page.

The limits and the deadline are settings of each class. The tool sends no email. A leader learns of a join request by opening the page.

## Instructor page (`admin.html`)

Only the accounts in the Worker's `ADMIN_EMAILS` secret can use it. Neither the deadline nor the size limits apply to changes made there.

| Tab | Tasks |
|---|---|
| Overview | Student link, title, deadline, limits, downloads of the groups and the full log, delete the class |
| Roster | Import the roster (see Roster files), add or remove one student, move a student to a group |
| Groups | Change the leader, assign or release a dataset or topic, delete a group |
| Datasets, Topics | Add, edit, or remove catalog items |
| Log | Every sign-in, action, and refused attempt with its reason, time, and account |

On the student page, an instructor account sees the whole board and can preview and act as any student. Preview actions are marked in the log.

## Roster files

Both tools import the same two layouts (`parseRoster` in `worker/src/rules.js`): the Canvas gradebook export, with a "Student" column ("Last, First") and a "SIS Login ID" column (the address before the @, completed with `@montclair.edu`; the "Points Possible" row and Canvas's test student are skipped), or a CSV with first name, last name, and email columns in any order. Addresses are lowercased, and `@mail.montclair.edu` is stored as `@montclair.edu`; a student may sign in with either form. The domain rule is the one line `canonEmail` in `rules.js`.

## Several classes

One backend serves every class. A class is created on the instructor page with a short key, and its student link is the page address followed by `?c=` and the key. A new class starts from the standard catalog in `worker/src/seed.js` or from a copy of an existing class's catalog and limits.

## Attendance tool

The same backend also serves a separate attendance tool: `docs/attendance.html` for students (link `attendance.html?c=key`) and `docs/attendance_admin.html` for the instructor. An attendance class has its own roster (same import), weekly class days with an opening and a closing clock time (New York time), optional first and last class days, holidays (a new class starts with the Fall 2026 schedule in `DEFAULT_SCHEDULE` and `DEFAULT_SKIP` of `worker/src/attendance.js`), and one-off windows ("Open attendance now for N minutes"; "Close attendance now" ends the open window at the current minute). Every window is one attendance round, identified by its date and opening minute, and marks are stored per round: opening attendance three times in a day records three rounds, each a column in the grid, and every student can mark again in each new round ("Open now" while a round is open closes that round and starts the next). A student signs in and presses one button while a round is open; the mark is refused outside a round. The instructor page shows the time left in the open window (mm:ss) and a QR code of the student link, on its own tab and full screen for the classroom projector, with the live status of attendance and questions. The instructor page shows a students-by-rounds grid (refreshed every 10 seconds; a switch shows today's rounds or every round, with compact rotated date headers), and downloads the grid as CSV. Cells are locked while a round is open; afterwards any cell can be switched by hand, changes stay pending until "Save" (or are dropped with "Don't save"), and leaving the tab, the class, or the page asks first. A manual change is recorded next to the student's own mark: each cell carries a change value of +1 (marked present by the instructor), -1 (marked by the student, set absent by the instructor), or 0 (the value equals what the student did, also after a change is undone). The grid colors changed cells, counts each student's changes, lists every change with its time below the grid, and the CSV has a change column beside each round.

Attendance points are set on the Settings tab, either per class meeting (for example 0.2 per round marked present) or as a semester total that is divided equally over every session from the first to the last class day (scheduled days minus holidays, plus one-off windows), so a perfect record over the first 4 of 28 sessions earns 4/28 of the total. A session with several rounds splits its points among them. The Reports tab lists each session (rounds, present counts, share of the roster, points) and each student (rounds present, percentage, points earned, points possible so far, semester points), both as CSV. The Log tab records every action with its time and account (windows opened and closed, marks and manual changes, questions, roster changes, settings), filterable to the instructor's actions, the students' actions, or everything, with a search box and CSV. The log is also where refused requests are listed.

The student page is a lobby: it stays open during class and refreshes itself (every 8 seconds from the window's opening for two hours, every 3 seconds while a question is open, otherwise every 30 seconds or at the next opening if sooner; a hidden tab does not poll). Besides attendance, the instructor asks in-class questions from the Questions tab: True/False, Yes/No, or multiple choice with 2 to 5 lettered choices, optional text, an optional correct answer, and a closing time (default 2 minutes). Students answer with one press and may change the answer until the question closes; answers are named. The instructor sees live counts per choice and each student's answer, can close, extend, or reopen a question, set the correct answer later, and download a students-by-questions CSV. Once a question closes, students see the correct answer if one was set. Rules are in `worker/src/attendance.js`; storage is the `att_classes`, `att_marks`, and `att_answers` tables, and the shared `log` table (class `att:` followed by the key).

## Sign-in

The pages use the "Sign in with Google" button. The Worker verifies Google's signature on each sign-in token and that the token was issued for this tool's client ID. The client ID is a public identifier created once in Google Cloud Console (type "Web application", with the page's origin, for example `https://USERNAME.github.io`, under "Authorized JavaScript origins"). It is the value of `GOOGLE_CLIENT_ID` in `worker/wrangler.toml`. The tool holds no permission on any Google account.

## Deployment

From `worker/`, with a Cloudflare account:

```
npx wrangler d1 create group-signup          # once; copy the database_id into wrangler.toml
npx wrangler d1 execute group-signup --remote --file schema.sql
npx wrangler secret put ADMIN_EMAILS         # comma-separated instructor emails
npx wrangler deploy
```

Then write the Worker's address into `docs/config.js`.

## Tests

- `node test/test_rules.mjs` checks the rules on an in-memory class.
- `node test/test_attendance.mjs` checks the attendance windows (New York time, clock changes, holidays), settings, roster import, in-class questions, the student view, session dates, and the points report.
- `node test/test_worker.mjs` checks a local copy of the Worker end to end, including simultaneous claims of one item (its header lists the commands).
- `node test/check_pages.mjs` checks that the page scripts parse.
