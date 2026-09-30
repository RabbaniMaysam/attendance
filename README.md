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

The same backend also serves a separate attendance tool: `docs/attendance.html` for students (link `attendance.html?c=key`) and `docs/attendance_admin.html` for the instructor. An attendance class has its own roster (same import), weekly class days with an opening and a closing clock time (New York time), optional first and last class days, holidays (a new class starts with the Fall 2026 schedule in `DEFAULT_SCHEDULE` and `DEFAULT_SKIP` of `worker/src/attendance.js`), and one-off windows ("Open attendance now for N minutes"). Marks are stored by date whichever window they were made in. A student signs in and presses one button while a window is open; the mark is refused outside a window. The instructor page shows a full-screen QR code of the student link for the classroom screen, with the live count of marks. The instructor page shows a students-by-dates grid (refreshed every 10 seconds), where any cell can be marked or cleared by hand, and downloads the grid as CSV. Rules are in `worker/src/attendance.js`; storage is the `att_classes` and `att_marks` tables.

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
- `node test/test_attendance.mjs` checks the attendance windows (New York time, clock changes, holidays), settings, roster import, and the student view.
- `node test/test_worker.mjs` checks a local copy of the Worker end to end, including simultaneous claims of one item (its header lists the commands).
- `node test/check_pages.mjs` checks that the page scripts parse.
