# Group sign-up

A web page where students form groups and claim one dataset and one presentation topic per group, first come, first served.

- `docs/` is the student page, served by GitHub Pages.
- `backend/` is the server logic, a Google Apps Script attached to one Google Sheet per class.
- `test/` checks the backend rules against an in-memory mock: `node test/test_backend.js`.

No student data is stored in this repository. Each class's roster, groups, claims, and activity log are in that class's Google Sheet.

## Rules the backend enforces

- Only emails on the Roster sheet can use the page. Students sign in with Google.
- A student creates a new group or asks to join an existing one. The student who created the group (the leader) approves or declines each request.
- A group has at most 3 members: the leader plus up to two approved students.
- Only the leader claims the dataset and topic, and only when the group has at least 2 members.
- A claimed dataset or topic is unavailable to other groups. A leader may switch to any unclaimed item, which releases the old one.
- If the leader leaves, the member who joined earliest becomes leader. A group whose last member leaves is deleted and its claims are released.
- The number of groups is capped (20 by default). Students are not shown the cap.
- After the deadline nothing can be changed from the page.

The limits, the deadline, and the instructor emails are cells in the Settings sheet.

## Administration (in the class's Google Sheet)

| Task | Where |
|---|---|
| Set or extend the deadline | Settings sheet |
| Upload or replace the roster | Menu: Sign-up tool > Import roster CSV (columns: first name, last name, email) |
| Move a student | Roster sheet, Group column (type the group name exactly, or clear the cell) |
| Release or assign a claim | Groups sheet, Dataset code or Topic code |
| Change the leader | Groups sheet, Leader email |
| Add a dataset or topic | Add a row with a new code to the Datasets or Topics sheet |
| Review what happened | Log sheet |

The Log sheet records every sign-in, every action, and every refused attempt with its reason, each with the time and the account.

Accounts listed under "Instructor emails" see the whole board on the page and can preview and act as any student. Preview actions are marked in the log and send no emails.

## Several classes

Each class is a separate Google Sheet with its own copy of the backend and its own entry in `docs/config.js`. The student link of a class is the page address followed by `?c=` and the class key.

## One-time Google setup

1. In Google Cloud Console, create an OAuth client ID of type "Web application" and add the page's origin (for example `https://USERNAME.github.io`) under "Authorized JavaScript origins".
2. Paste the client ID into the "Google client ID" cell of each class's Settings sheet.
