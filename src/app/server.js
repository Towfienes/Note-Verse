const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const nodemailer = require("nodemailer");
const Database = require("better-sqlite3");
const { WebSocketServer } = require("ws");
const http = require("http");

const PORT = Number(process.env.PORT || 8080);
const BASE = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "noteverse.sqlite"));
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_path TEXT,
  is_active INTEGER DEFAULT 0,
  activation_token TEXT,
  reset_token TEXT,
  reset_expires INTEGER,
  preferences TEXT DEFAULT '{"fontSize":16,"theme":"light","defaultColor":"#ffffff"}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  color TEXT DEFAULT '#ffffff',
  is_pinned INTEGER DEFAULT 0,
  pinned_at TEXT,
  password_hash TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS note_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  original_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
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
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(note_id, recipient_id),
  FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(recipient_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

function seedDemoData() {
  const count = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  if (count) return;
  const pass = bcrypt.hashSync("123456", 10);
  const u1 = db
    .prepare(
      "INSERT INTO users(email,display_name,password_hash,is_active) VALUES(?,?,?,1)",
    )
    .run("alice@example.com", "Alice Owner", pass).lastInsertRowid;
  const u2 = db
    .prepare(
      "INSERT INTO users(email,display_name,password_hash,is_active) VALUES(?,?,?,1)",
    )
    .run("bob@example.com", "Bob Editor", pass).lastInsertRowid;
  const u3 = db
    .prepare(
      "INSERT INTO users(email,display_name,password_hash,is_active) VALUES(?,?,?,1)",
    )
    .run("cara@example.com", "Cara Reader", pass).lastInsertRowid;
  const work = db
    .prepare("INSERT INTO labels(user_id,name) VALUES(?,?)")
    .run(u1, "Work").lastInsertRowid;
  const school = db
    .prepare("INSERT INTO labels(user_id,name) VALUES(?,?)")
    .run(u1, "School").lastInsertRowid;
  const n1 = db
    .prepare(
      "INSERT INTO notes(user_id,title,content,color,is_pinned,pinned_at) VALUES(?,?,?,?,1,CURRENT_TIMESTAMP)",
    )
    .run(
      u1,
      "Pinned project checklist",
      "This note is pinned. Try list/grid view, live search, labels, sharing, images, and auto-save.",
      "#fff7ed",
    ).lastInsertRowid;
  const n2 = db
    .prepare("INSERT INTO notes(user_id,title,content,color) VALUES(?,?,?,?)")
    .run(
      u1,
      "Shared editable note",
      "Bob can edit this note in realtime using WebSocket. Open Alice and Bob in two browsers to test.",
      "#eef2ff",
    ).lastInsertRowid;
  const n3 = db
    .prepare(
      "INSERT INTO notes(user_id,title,content,color,password_hash) VALUES(?,?,?,?,?)",
    )
    .run(
      u1,
      "Protected note",
      "Unlock password is note123. This checks password-protected notes.",
      "#fef2f2",
      bcrypt.hashSync("note123", 10),
    ).lastInsertRowid;
  db.prepare("INSERT INTO note_labels(note_id,label_id) VALUES(?,?)").run(
    n1,
    work,
  );
  db.prepare("INSERT INTO note_labels(note_id,label_id) VALUES(?,?)").run(
    n2,
    school,
  );
  db.prepare(
    "INSERT INTO shares(note_id,owner_id,recipient_id,permission) VALUES(?,?,?,?)",
  ).run(n2, u1, u2, "edit");
  db.prepare(
    "INSERT INTO shares(note_id,owner_id,recipient_id,permission) VALUES(?,?,?,?)",
  ).run(n1, u1, u3, "read");
}
seedDemoData();

const app = express();
const server = http.createServer(app);
const sessionParser = session({
  secret: process.env.SESSION_SECRET || "dev-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 8 },
});

app.use(
  helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }),
);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(sessionParser);
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename: (_, file, cb) =>
      cb(
        null,
        `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${path.extname(file.originalname)}`,
      ),
  }),
  fileFilter: (_, file, cb) => cb(null, file.mimetype.startsWith("image/")),
  limits: { fileSize: 5 * 1024 * 1024, files: 8 },
});

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "localhost",
  port: Number(process.env.SMTP_PORT || 1025),
  secure: false,
});

function token() {
  return crypto.randomBytes(24).toString("hex");
}
function clean(s) {
  return String(s ?? "")
    .replace(/[<>]/g, "")
    .trim();
}
function requireAuth(req, res, next) {
  if (!req.session.userId)
    return res.status(401).json({ error: "Please log in first." });
  next();
}
function userById(id) {
  return db
    .prepare(
      "SELECT id,email,display_name,avatar_path,is_active,preferences FROM users WHERE id=?",
    )
    .get(id);
}
function canAccess(userId, noteId) {
  const note = db.prepare("SELECT * FROM notes WHERE id=?").get(noteId);
  if (!note) return null;
  if (note.user_id === userId)
    return { note, role: "owner", permission: "edit" };
  const share = db
    .prepare(
      "SELECT s.*, u.email owner_email, u.display_name owner_name FROM shares s JOIN users u ON u.id=s.owner_id WHERE s.note_id=? AND s.recipient_id=?",
    )
    .get(noteId, userId);
  if (share)
    return { note, role: "shared", permission: share.permission, share };
  return null;
}
function ensureUnlocked(req, note) {
  if (!note.password_hash) return true;
  req.session.unlockedNotes = req.session.unlockedNotes || {};
  return Boolean(req.session.unlockedNotes[note.id]);
}
function hydrateNote(row, viewerId) {
  const labels = db
    .prepare(
      "SELECT l.id,l.name FROM labels l JOIN note_labels nl ON nl.label_id=l.id WHERE nl.note_id=? ORDER BY l.name",
    )
    .all(row.id);
  const images = db
    .prepare(
      "SELECT id,path,original_name FROM note_images WHERE note_id=? ORDER BY id DESC",
    )
    .all(row.id);
  const shares =
    row.user_id === viewerId
      ? db
          .prepare(
            `SELECT s.id,s.permission,s.created_at,u.email,u.display_name FROM shares s JOIN users u ON u.id=s.recipient_id WHERE s.note_id=? ORDER BY s.created_at DESC`,
          )
          .all(row.id)
      : [];
  const incoming = db
    .prepare(
      `SELECT s.permission,s.created_at,u.email owner_email,u.display_name owner_name FROM shares s JOIN users u ON u.id=s.owner_id WHERE s.note_id=? AND s.recipient_id=?`,
    )
    .get(row.id, viewerId);
  return {
    ...row,
    is_locked: !!row.password_hash,
    password_hash: undefined,
    labels,
    images,
    shares,
    incoming,
  };
}
async function sendMail(to, subject, html) {
  await mailer.sendMail({
    from: process.env.MAIL_FROM || "noreply@localhost",
    to,
    subject,
    html,
  });
}

app.post("/api/register", async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const displayName = clean(req.body.displayName);
  const password = String(req.body.password || "");
  const confirm = String(req.body.confirm || "");
  if (
    !email ||
    !displayName ||
    !password ||
    password !== confirm ||
    password.length < 6
  )
    return res
      .status(400)
      .json({
        error:
          "Email, display name, and matching passwords with at least 6 characters are required.",
      });
  const activation = token();
  try {
    const info = db
      .prepare(
        "INSERT INTO users(email,display_name,password_hash,activation_token) VALUES(?,?,?,?)",
      )
      .run(email, displayName, await bcrypt.hash(password, 10), activation);
    req.session.userId = info.lastInsertRowid;
    await sendMail(
      email,
      "Activate your NoteVerse account",
      `<p>Hello ${displayName},</p><p>Activate your account: <a href="${BASE}/api/activate/${activation}">${BASE}/api/activate/${activation}</a></p>`,
    );
    res.json({ ok: true });
  } catch (e) {
    res
      .status(409)
      .json({ error: "Email already exists or cannot be registered." });
  }
});
app.post("/api/login", async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (
    !user ||
    !(await bcrypt.compare(String(req.body.password || ""), user.password_hash))
  )
    return res.status(401).json({ error: "Invalid email or password." });
  req.session.userId = user.id;
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) =>
  req.session.destroy(() => res.json({ ok: true })),
);
app.get("/api/me", requireAuth, (req, res) => {
  const user = userById(req.session.userId);
  const notifications = db
    .prepare(
      "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 10",
    )
    .all(req.session.userId);
  res.json({
    user: { ...user, preferences: JSON.parse(user.preferences || "{}") },
    notifications,
  });
});
app.get("/api/activate/:token", (req, res) => {
  const u = db
    .prepare("SELECT * FROM users WHERE activation_token=?")
    .get(req.params.token);
  if (!u)
    return res.send(
      '<h2>Activation link is invalid or already used.</h2><p><a href="/">Back to app</a></p>',
    );
  db.prepare(
    "UPDATE users SET is_active=1, activation_token=NULL WHERE id=?",
  ).run(u.id);
  res.send(
    '<h2>Account activated successfully.</h2><p><a href="/">Back to app</a></p>',
  );
});
app.post("/api/password/request-reset", async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (u) {
    const reset = token();
    db.prepare(
      "UPDATE users SET reset_token=?, reset_expires=? WHERE id=?",
    ).run(reset, Date.now() + 3600000, u.id);
    await sendMail(
      email,
      "Reset your NoteVerse password",
      `<p>Reset link: <a href="${BASE}/reset.html?token=${reset}">${BASE}/reset.html?token=${reset}</a></p><p>OTP/token: <b>${reset}</b></p>`,
    );
  }
  res.json({
    ok: true,
    message: "If that email exists, reset instructions were sent.",
  });
});
app.post("/api/password/reset", async (req, res) => {
  const reset = clean(req.body.token);
  const password = String(req.body.password || "");
  const confirm = String(req.body.confirm || "");
  const u = db
    .prepare("SELECT * FROM users WHERE reset_token=? AND reset_expires>?")
    .get(reset, Date.now());
  if (!u || password !== confirm || password.length < 6)
    return res
      .status(400)
      .json({ error: "Invalid token or password confirmation." });
  db.prepare(
    "UPDATE users SET password_hash=?, reset_token=NULL, reset_expires=NULL WHERE id=?",
  ).run(await bcrypt.hash(password, 10), u.id);
  req.session.destroy(() => res.json({ ok: true }));
});
app.post("/api/password/change", requireAuth, async (req, res) => {
  const u = db
    .prepare("SELECT * FROM users WHERE id=?")
    .get(req.session.userId);
  if (
    !(await bcrypt.compare(String(req.body.current || ""), u.password_hash)) ||
    req.body.password !== req.body.confirm ||
    String(req.body.password || "").length < 6
  )
    return res
      .status(400)
      .json({
        error: "Current password or new password confirmation is invalid.",
      });
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
    await bcrypt.hash(String(req.body.password), 10),
    u.id,
  );
  res.json({ ok: true });
});
app.put("/api/profile", requireAuth, upload.single("avatar"), (req, res) => {
  const display = clean(req.body.displayName);
  const avatar = req.file ? `/uploads/${req.file.filename}` : undefined;
  if (!display)
    return res.status(400).json({ error: "Display name is required." });
  if (avatar)
    db.prepare("UPDATE users SET display_name=?, avatar_path=? WHERE id=?").run(
      display,
      avatar,
      req.session.userId,
    );
  else
    db.prepare("UPDATE users SET display_name=? WHERE id=?").run(
      display,
      req.session.userId,
    );
  res.json({ ok: true });
});
app.put("/api/preferences", requireAuth, (req, res) => {
  const prefs = {
    fontSize: Number(req.body.fontSize || 16),
    theme: req.body.theme === "dark" ? "dark" : "light",
    defaultColor: clean(req.body.defaultColor || "#ffffff"),
  };
  db.prepare("UPDATE users SET preferences=? WHERE id=?").run(
    JSON.stringify(prefs),
    req.session.userId,
  );
  res.json({ ok: true, preferences: prefs });
});

app.get("/api/labels", requireAuth, (req, res) =>
  res.json(
    db
      .prepare("SELECT * FROM labels WHERE user_id=? ORDER BY name")
      .all(req.session.userId),
  ),
);
app.post("/api/labels", requireAuth, (req, res) => {
  const name = clean(req.body.name);
  if (!name) return res.status(400).json({ error: "Label name is required." });
  try {
    const r = db
      .prepare("INSERT INTO labels(user_id,name) VALUES(?,?)")
      .run(req.session.userId, name);
    res.json({ id: r.lastInsertRowid, name });
  } catch {
    res.status(409).json({ error: "Label already exists." });
  }
});
app.put("/api/labels/:id", requireAuth, (req, res) => {
  const name = clean(req.body.name);
  if (!name) return res.status(400).json({ error: "Label name is required." });
  db.prepare("UPDATE labels SET name=? WHERE id=? AND user_id=?").run(
    name,
    req.params.id,
    req.session.userId,
  );
  res.json({ ok: true });
});
app.delete("/api/labels/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM labels WHERE id=? AND user_id=?").run(
    req.params.id,
    req.session.userId,
  );
  res.json({ ok: true });
});

app.get("/api/notes", requireAuth, (req, res) => {
  const q = `%${clean(req.query.search || "")}%`;
  const labelId = req.query.label ? Number(req.query.label) : null;
  let owned = db
    .prepare(
      `SELECT n.*, 'owner' role, 'edit' permission FROM notes n WHERE n.user_id=? AND (n.title LIKE ? OR n.content LIKE ?) ORDER BY n.is_pinned DESC, COALESCE(n.pinned_at,n.updated_at) DESC`,
    )
    .all(req.session.userId, q, q);
  let shared = db
    .prepare(
      `SELECT n.*, 'shared' role, s.permission FROM notes n JOIN shares s ON s.note_id=n.id WHERE s.recipient_id=? AND (n.title LIKE ? OR n.content LIKE ?) ORDER BY n.updated_at DESC`,
    )
    .all(req.session.userId, q, q);
  let rows = owned.concat(shared);
  if (labelId)
    rows = rows.filter((n) =>
      db
        .prepare("SELECT 1 FROM note_labels WHERE note_id=? AND label_id=?")
        .get(n.id, labelId),
    );
  res.json(
    rows.map((n) => {
      const hydrated = hydrateNote(n, req.session.userId);
      if (hydrated.is_locked && !ensureUnlocked(req, n)) hydrated.content = "";
      return hydrated;
    }),
  );
});
app.post("/api/notes", requireAuth, (req, res) => {
  const title = clean(req.body.title || "Untitled");
  const content = clean(req.body.content || "");
  const color = clean(req.body.color || "#ffffff");
  const r = db
    .prepare("INSERT INTO notes(user_id,title,content,color) VALUES(?,?,?,?)")
    .run(req.session.userId, title, content, color);
  res.json(
    hydrateNote(
      db.prepare("SELECT * FROM notes WHERE id=?").get(r.lastInsertRowid),
      req.session.userId,
    ),
  );
});
app.put("/api/notes/:id", requireAuth, (req, res) => {
  const access = canAccess(req.session.userId, Number(req.params.id));
  if (!access || access.permission !== "edit")
    return res.status(403).json({ error: "No edit permission." });
  if (!ensureUnlocked(req, access.note))
    return res.status(423).json({ error: "Note is password-protected." });
  const color =
    req.body.color === undefined
      ? access.note.color
      : clean(req.body.color || "#ffffff");
  db.prepare(
    "UPDATE notes SET title=?, content=?, color=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
  ).run(clean(req.body.title), clean(req.body.content), color, access.note.id);
  broadcast(access.note.id, {
    type: "saved",
    noteId: access.note.id,
    title: clean(req.body.title),
    content: clean(req.body.content),
    from: req.session.userId,
  });
  res.json({ ok: true });
});
app.delete("/api/notes/:id", requireAuth, (req, res) => {
  const note = db
    .prepare("SELECT * FROM notes WHERE id=? AND user_id=?")
    .get(req.params.id, req.session.userId);
  if (!note) return res.status(404).json({ error: "Note not found." });
  if (!ensureUnlocked(req, note))
    return res.status(423).json({ error: "Note is password-protected." });
  db.prepare("DELETE FROM notes WHERE id=?").run(note.id);
  res.json({ ok: true });
});
app.post("/api/notes/:id/unlock", requireAuth, async (req, res) => {
  const access = canAccess(req.session.userId, Number(req.params.id));
  if (!access) return res.status(404).json({ error: "Note not found." });
  if (
    !access.note.password_hash ||
    (await bcrypt.compare(
      String(req.body.password || ""),
      access.note.password_hash,
    ))
  ) {
    req.session.unlockedNotes = req.session.unlockedNotes || {};
    req.session.unlockedNotes[access.note.id] = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Wrong note password." });
});
app.post("/api/notes/:id/password", requireAuth, async (req, res) => {
  const note = db
    .prepare("SELECT * FROM notes WHERE id=? AND user_id=?")
    .get(req.params.id, req.session.userId);
  if (!note)
    return res
      .status(404)
      .json({ error: "Only the owner can change note password." });
  const action = req.body.action;
  if (action === "disable") {
    if (
      note.password_hash &&
      !(await bcrypt.compare(
        String(req.body.current || ""),
        note.password_hash,
      ))
    )
      return res.status(401).json({ error: "Current note password is wrong." });
    db.prepare("UPDATE notes SET password_hash=NULL WHERE id=?").run(note.id);
    return res.json({ ok: true });
  }
  if (
    note.password_hash &&
    !(await bcrypt.compare(String(req.body.current || ""), note.password_hash))
  )
    return res.status(401).json({ error: "Current note password is wrong." });
  if (
    String(req.body.password || "").length < 4 ||
    req.body.password !== req.body.confirm
  )
    return res
      .status(400)
      .json({ error: "New note password confirmation is invalid." });
  db.prepare("UPDATE notes SET password_hash=? WHERE id=?").run(
    await bcrypt.hash(String(req.body.password), 10),
    note.id,
  );
  req.session.unlockedNotes = req.session.unlockedNotes || {};
  req.session.unlockedNotes[note.id] = true;
  res.json({ ok: true });
});
app.post("/api/notes/:id/pin", requireAuth, (req, res) => {
  const note = db
    .prepare("SELECT * FROM notes WHERE id=? AND user_id=?")
    .get(req.params.id, req.session.userId);
  if (!note) return res.status(404).json({ error: "Only owner can pin." });
  if (!ensureUnlocked(req, note))
    return res.status(423).json({ error: "Note is password-protected." });
  const pin = req.body.pin ? 1 : 0;
  db.prepare("UPDATE notes SET is_pinned=?, pinned_at=? WHERE id=?").run(
    pin,
    pin ? new Date().toISOString() : null,
    note.id,
  );
  res.json({ ok: true });
});
app.post(
  "/api/notes/:id/images",
  requireAuth,
  upload.array("images", 8),
  (req, res) => {
    const access = canAccess(req.session.userId, Number(req.params.id));
    if (!access || access.permission !== "edit")
      return res.status(403).json({ error: "No edit permission." });
    if (!ensureUnlocked(req, access.note))
      return res.status(423).json({ error: "Note is password-protected." });
    for (const f of req.files)
      db.prepare(
        "INSERT INTO note_images(note_id,path,original_name) VALUES(?,?,?)",
      ).run(access.note.id, `/uploads/${f.filename}`, f.originalname);
    res.json({ ok: true });
  },
);
app.delete("/api/notes/:id/images/:imageId", requireAuth, (req, res) => {
  const access = canAccess(req.session.userId, Number(req.params.id));
  if (!access || access.permission !== "edit")
    return res.status(403).json({ error: "No edit permission." });
  if (!ensureUnlocked(req, access.note))
    return res.status(423).json({ error: "Note is password-protected." });
  const image = db
    .prepare("SELECT * FROM note_images WHERE id=? AND note_id=?")
    .get(Number(req.params.imageId), access.note.id);
  if (!image) return res.status(404).json({ error: "Image not found." });
  db.prepare("DELETE FROM note_images WHERE id=?").run(image.id);
  const filePath = path.join(UPLOAD_DIR, path.basename(image.path));
  fs.unlink(filePath, () => {});
  res.json({ ok: true });
});
app.post("/api/notes/:id/labels", requireAuth, (req, res) => {
  const note = db
    .prepare("SELECT * FROM notes WHERE id=? AND user_id=?")
    .get(req.params.id, req.session.userId);
  if (!note) return res.status(404).json({ error: "Only owner can label." });
  db.prepare("DELETE FROM note_labels WHERE note_id=?").run(note.id);
  for (const id of req.body.labelIds || [])
    db.prepare(
      "INSERT OR IGNORE INTO note_labels(note_id,label_id) VALUES(?,?)",
    ).run(note.id, Number(id));
  res.json({ ok: true });
});
app.post("/api/notes/:id/share", requireAuth, async (req, res) => {
  const note = db
    .prepare("SELECT * FROM notes WHERE id=? AND user_id=?")
    .get(req.params.id, req.session.userId);
  if (!note) return res.status(404).json({ error: "Only owner can share." });
  const emails = String(req.body.emails || "")
    .split(",")
    .map((e) => clean(e).toLowerCase())
    .filter(Boolean);
  const permission = req.body.permission === "edit" ? "edit" : "read";
  const missing = [];
  for (const email of emails) {
    const rec = db.prepare("SELECT * FROM users WHERE email=?").get(email);
    if (!rec) {
      missing.push(email);
      continue;
    }
    if (rec.id === req.session.userId) continue;
    db.prepare(
      "INSERT INTO shares(note_id,owner_id,recipient_id,permission) VALUES(?,?,?,?) ON CONFLICT(note_id,recipient_id) DO UPDATE SET permission=excluded.permission, created_at=CURRENT_TIMESTAMP",
    ).run(note.id, req.session.userId, rec.id, permission);
    db.prepare("INSERT INTO notifications(user_id,message) VALUES(?,?)").run(
      rec.id,
      `A note titled "${note.title}" was shared with ${permission} permission.`,
    );
    await sendMail(
      rec.email,
      "A NoteVerse note was shared with you",
      `<p>${userById(req.session.userId).display_name} shared "${note.title}" with ${permission} permission.</p><p><a href="${BASE}/">Open NoteVerse</a></p>`,
    ).catch(() => {});
  }
  res.json({ ok: true, missing });
});
app.post("/api/notifications/mark-read", requireAuth, (req, res) => {
  db.prepare("UPDATE notifications SET is_read=1 WHERE user_id=?").run(
    req.session.userId,
  );
  res.json({ ok: true });
});
app.put("/api/shares/:id", requireAuth, (req, res) => {
  const share = db
    .prepare("SELECT * FROM shares WHERE id=? AND owner_id=?")
    .get(req.params.id, req.session.userId);
  if (!share) return res.status(404).json({ error: "Share not found." });
  db.prepare("UPDATE shares SET permission=? WHERE id=?").run(
    req.body.permission === "edit" ? "edit" : "read",
    share.id,
  );
  res.json({ ok: true });
});
app.delete("/api/shares/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM shares WHERE id=? AND owner_id=?").run(
    req.params.id,
    req.session.userId,
  );
  res.json({ ok: true });
});

app.get("/reset.html", (_, res) =>
  res.sendFile(path.join(__dirname, "public", "reset.html")),
);
app.get("*", (_, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);

const wss = new WebSocketServer({ noServer: true });
const rooms = new Map();
function broadcast(noteId, msg, except) {
  const set = rooms.get(String(noteId));
  if (!set) return;
  for (const ws of set)
    if (ws !== except && ws.readyState === ws.OPEN)
      ws.send(JSON.stringify(msg));
}
server.on("upgrade", (req, socket, head) => {
  sessionParser(req, {}, () => {
    if (!req.session.userId) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
});
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, BASE);
  const noteId = url.searchParams.get("noteId");
  const access = canAccess(req.session.userId, Number(noteId));
  if (!access || access.permission !== "edit") return ws.close();
  rooms.set(noteId, rooms.get(noteId) || new Set());
  rooms.get(noteId).add(ws);
  ws.send(
    JSON.stringify({
      type: "presence",
      message: "Realtime collaboration connected.",
    }),
  );
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "edit" && ensureUnlocked(req, access.note)) {
        db.prepare(
          "UPDATE notes SET title=?, content=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
        ).run(clean(msg.title), clean(msg.content), Number(noteId));
        broadcast(
          noteId,
          {
            type: "remoteEdit",
            title: clean(msg.title),
            content: clean(msg.content),
            from: req.session.userId,
          },
          ws,
        );
      }
    } catch {}
  });
  ws.on("close", () => rooms.get(noteId)?.delete(ws));
});

server.listen(PORT, () => console.log(`NoteVerse running at ${BASE}`));
