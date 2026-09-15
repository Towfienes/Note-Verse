# NoteVerse architecture notes

This is the short version to use when explaining the project in an interview.

## Boundaries

- `server.js` only starts and stops the process.
- `src/application.js` composes Express, security headers, the session store, API routers, static files, mail, and WebSocket.
- `src/database.js` owns schema creation, additive migrations, WAL mode, and explicitly enabled demo data.
- `src/routes/auth.js` owns account, activation, reset, profile, and preference endpoints.
- `src/routes/notes.js` owns notes, permissions, labels, uploads, trash, sharing, and import/export.
- `src/realtime.js` owns WebSocket connection/session/permission revalidation and room broadcast.
- `public/app.js` is browser orchestration; `public/markdown.js` is the small safe Markdown renderer.

## Saving a note

1. Typing updates the in-memory note and the account-scoped browser snapshot immediately.
2. Autosave sends the draft plus its `baseVersion`.
3. SQLite updates only when the row still has that version, then atomically increments it.
4. A successful save is broadcast to authorized, unlocked WebSocket peers.
5. A stale save receives HTTP 409 with the current server version. The browser retains the local draft and asks the user to choose.

This compare-and-swap pattern prevents delayed autosave, realtime, or offline work from silently replacing newer text.

## Authorization model

Every note has one owner. A `shares` row can grant another active account `read` or `edit` permission. Each HTTP request queries current database state; hidden buttons are only UX, never the security boundary. Labels must belong to the owner assigning them.

Attachments are not static public URLs. `/api/images/:id` checks the current session, note access, deletion state, and note unlock before reading the file. Upload authorization runs before Multer reads the multipart body, and bytes reach disk only after magic-byte validation.

## Realtime model

The WebSocket handshake parses the same server-side session as HTTP. On every edit and before every outbound private message, the server reloads the session and rechecks:

- the account is active and its session version is current;
- the share still exists with edit permission when writing;
- the note is not deleted;
- the session unlocked the current `lock_version`;
- the edit's base version is current.

Changing a share calls `closeInvalid`, so a downgrade/revoke affects already-open sockets. Changing a note password increments `lock_version`, invalidating earlier unlocks.

## Offline model

The service worker caches only the static application shell. Note data lives in local storage keys shaped as `noteverse:<userId>:<kind>`. Logout removes the active account's profile, note snapshots, and edit queue.

An offline edit stores title/content/color, the last known server version, and its queued time. Reconnect attempts the normal versioned API write. Network, permission, lock, and conflict failures retain the draft. Only successful sync or an explicit “use server version” decision removes it.

Protected-note plaintext is deliberately redacted from browser storage. If an unlocked protected note goes offline while being edited, its draft remains in memory and navigation is blocked until it can be saved; persisting it would undermine the secondary password boundary.

## Deliberate constraints

The design stays on the original stack. SQLite and process-local WebSocket rooms are easy to run and explain for a single instance. Scaling out would require a shared session/rate-limit/realtime layer and a database chosen for concurrent multi-instance writes.
