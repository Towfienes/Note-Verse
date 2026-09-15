const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((entry) => entry.name === column);
}

function addColumn(db, table, definition) {
  const column = definition.trim().split(/\s+/)[0];
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_path TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      activation_token TEXT,
      reset_token TEXT,
      reset_expires INTEGER,
      preferences TEXT NOT NULL DEFAULT '{"fontSize":16,"theme":"light","defaultColor":"#ffffff"}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#ffffff',
      is_pinned INTEGER NOT NULL DEFAULT 0,
      pinned_at TEXT,
      password_hash TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS note_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      original_name TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS note_labels (
      note_id INTEGER NOT NULL,
      label_id INTEGER NOT NULL,
      PRIMARY KEY(note_id, label_id),
      FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY(label_id) REFERENCES labels(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      owner_id INTEGER NOT NULL,
      recipient_id INTEGER NOT NULL,
      permission TEXT NOT NULL CHECK(permission IN ('read','edit')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(note_id, recipient_id),
      FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(recipient_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expired_at INTEGER NOT NULL
    );
  `);

  addColumn(db, "users", "activation_expires INTEGER");
  addColumn(db, "users", "session_version INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "notes", "version INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "notes", "deleted_at TEXT");
  addColumn(db, "notes", "lock_version INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notes_owner_deleted ON notes(user_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_shares_recipient ON shares(recipient_id, note_id);
    CREATE INDEX IF NOT EXISTS idx_note_images_note ON note_images(note_id);
  `);
}

function createDatabase(config) {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const db = new Database(config.databasePath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function seedDemoData(db) {
  const emails = ["alice@example.com", "bob@example.com", "cara@example.com"];
  if (db.prepare(`SELECT 1 FROM users WHERE email IN (?,?,?) LIMIT 1`).get(...emails)) return false;

  const create = db.transaction(() => {
    const password = bcrypt.hashSync("123456", 12);
    const userStatement = db.prepare(
      "INSERT INTO users(email,display_name,password_hash,is_active) VALUES(?,?,?,1)",
    );
    const alice = Number(userStatement.run(emails[0], "Alice Owner", password).lastInsertRowid);
    const bob = Number(userStatement.run(emails[1], "Bob Editor", password).lastInsertRowid);
    const cara = Number(userStatement.run(emails[2], "Cara Reader", password).lastInsertRowid);
    const labelStatement = db.prepare("INSERT INTO labels(user_id,name) VALUES(?,?)");
    const work = Number(labelStatement.run(alice, "Work").lastInsertRowid);
    const school = Number(labelStatement.run(alice, "School").lastInsertRowid);
    const insertNote = db.prepare(
      "INSERT INTO notes(user_id,title,content,color,is_pinned,pinned_at,password_hash) VALUES(?,?,?,?,?,?,?)",
    );
    const checklist = Number(
      insertNote.run(
        alice,
        "Pinned project checklist",
        "# NoteVerse demo\n\nTry the list/grid view, labels, sharing, Markdown preview, and offline editing.",
        "#fff7ed",
        1,
        new Date().toISOString(),
        null,
      ).lastInsertRowid,
    );
    const shared = Number(
      insertNote.run(
        alice,
        "Shared editable note",
        "Bob can edit this note in realtime. Open Alice and Bob in two browser profiles to test.",
        "#eef2ff",
        0,
        null,
        null,
      ).lastInsertRowid,
    );
    insertNote.run(
      alice,
      "Protected note",
      "Unlock password: `note123`. This is password access control, not end-to-end encryption.",
      "#fef2f2",
      0,
      null,
      bcrypt.hashSync("note123", 12),
    );
    db.prepare("INSERT INTO note_labels(note_id,label_id) VALUES(?,?)").run(checklist, work);
    db.prepare("INSERT INTO note_labels(note_id,label_id) VALUES(?,?)").run(shared, school);
    db.prepare("INSERT INTO shares(note_id,owner_id,recipient_id,permission) VALUES(?,?,?,?)").run(
      shared,
      alice,
      bob,
      "edit",
    );
    db.prepare("INSERT INTO shares(note_id,owner_id,recipient_id,permission) VALUES(?,?,?,?)").run(
      checklist,
      alice,
      cara,
      "read",
    );
  });
  create();
  return true;
}

function cleanupExpiredSessions(db) {
  db.prepare("DELETE FROM sessions WHERE expired_at <= ?").run(Date.now());
}

module.exports = { cleanupExpiredSessions, createDatabase, migrate, seedDemoData };
