# Database migration and recovery

NoteVerse runs additive, idempotent migrations during startup. It creates missing tables and adds missing columns; it does not drop old tables or rewrite note content.

## Before an upgrade

1. Stop every NoteVerse process.
2. Copy `data/noteverse.sqlite` and the entire `uploads` directory to a dated backup location outside the repository.
3. Keep any `noteverse.sqlite-wal` and `noteverse.sqlite-shm` files with the database if they still exist after shutdown.
4. Start the new version once and run the integration tests against a separate temporary database.

## Added by the portfolio upgrade

- `users.activation_expires` bounds activation links.
- `users.session_version` revokes old sessions after credential changes.
- `notes.version` provides optimistic concurrency.
- `notes.deleted_at` implements reversible trash.
- `notes.lock_version` invalidates unlocks after a note password changes.
- `sessions` stores expiring server-side session JSON in SQLite.

## Recovery

If startup fails, stop the process, preserve the failed database for diagnosis, and restore both the database and upload backup together. Do not copy a backup over a running WAL-mode database.

