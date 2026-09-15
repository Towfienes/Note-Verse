const path = require("path");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { asyncRoute } = require("../middleware");
const { accessNote, conflictResponse, hydrateNote, isUnlocked } = require("../notes");
const { color, email, html, text } = require("../security");
const { persistImage, removeStoredFile } = require("../uploads");

function noteInput(body, existing = {}) {
  return {
    title: text(body.title ?? existing.title ?? "Untitled", { max: 200, trim: true }) || "Untitled",
    content: text(body.content ?? existing.content ?? "", { max: 500_000 }),
    color: color(body.color, existing.color || "#ffffff"),
  };
}

function requireOwnedNote(db, { deleted = false } = {}) {
  return (req, res, next) => {
    const clause = deleted ? "deleted_at IS NOT NULL" : "deleted_at IS NULL";
    req.note = db
      .prepare(`SELECT * FROM notes WHERE id=? AND user_id=? AND ${clause}`)
      .get(Number(req.params.id), req.user.id);
    if (!req.note) return res.status(404).json({ error: "Note not found." });
    next();
  };
}

function registerNoteRoutes(router, context) {
  const { config, db, requireAuth, unlockLimiter, realtime, mailer } = context;
  const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxImageBytes, files: config.maxImagesPerUpload },
  });

  router.get("/labels", requireAuth, (req, res) => {
    res.json(
      db
        .prepare("SELECT id,name,created_at FROM labels WHERE user_id=? ORDER BY name")
        .all(req.user.id),
    );
  });

  router.post("/labels", requireAuth, (req, res) => {
    const name = text(req.body.name, { max: 60, trim: true });
    if (!name) return res.status(400).json({ error: "Label name is required." });
    try {
      const result = db
        .prepare("INSERT INTO labels(user_id,name) VALUES(?,?)")
        .run(req.user.id, name);
      res.status(201).json({ id: Number(result.lastInsertRowid), name });
    } catch (error) {
      if (String(error.code).startsWith("SQLITE_CONSTRAINT")) {
        return res.status(409).json({ error: "Label already exists." });
      }
      throw error;
    }
  });

  router.put("/labels/:id", requireAuth, (req, res) => {
    const name = text(req.body.name, { max: 60, trim: true });
    if (!name) return res.status(400).json({ error: "Label name is required." });
    const result = db
      .prepare("UPDATE labels SET name=? WHERE id=? AND user_id=?")
      .run(name, Number(req.params.id), req.user.id);
    if (!result.changes) return res.status(404).json({ error: "Label not found." });
    res.json({ ok: true });
  });

  router.delete("/labels/:id", requireAuth, (req, res) => {
    const result = db
      .prepare("DELETE FROM labels WHERE id=? AND user_id=?")
      .run(Number(req.params.id), req.user.id);
    if (!result.changes) return res.status(404).json({ error: "Label not found." });
    res.json({ ok: true });
  });

  router.get("/notes", requireAuth, (req, res) => {
    const trash = req.query.trash === "1";
    const search = text(req.query.search, { max: 200, trim: true }).toLocaleLowerCase();
    let rows;
    if (trash) {
      rows = db
        .prepare(
          `SELECT n.*,'owner' role,'edit' permission FROM notes n
           WHERE n.user_id=? AND n.deleted_at IS NOT NULL
           ORDER BY n.deleted_at DESC`,
        )
        .all(req.user.id);
    } else {
      const owned = db
        .prepare(
          `SELECT n.*,'owner' role,'edit' permission FROM notes n
           WHERE n.user_id=? AND n.deleted_at IS NULL
           ORDER BY n.is_pinned DESC,COALESCE(n.pinned_at,n.updated_at) DESC`,
        )
        .all(req.user.id);
      const shared = db
        .prepare(
          `SELECT n.*,'shared' role,s.permission FROM notes n JOIN shares s ON s.note_id=n.id
           WHERE s.recipient_id=? AND n.deleted_at IS NULL
           ORDER BY n.updated_at DESC`,
        )
        .all(req.user.id);
      rows = owned.concat(shared);
    }
    let hydrated = rows.map((row) => hydrateNote(db, row, req.user.id, req.session));
    if (search) {
      hydrated = hydrated.filter((note) =>
        `${note.title}\n${note.content}`.toLocaleLowerCase().includes(search),
      );
    }
    const labelId = Number(req.query.label);
    if (Number.isSafeInteger(labelId) && labelId > 0) {
      const ownedLabel = db
        .prepare("SELECT 1 FROM labels WHERE id=? AND user_id=?")
        .get(labelId, req.user.id);
      if (!ownedLabel) return res.status(404).json({ error: "Label not found." });
      hydrated = hydrated.filter((note) => note.labels.some((label) => label.id === labelId));
    }
    res.json(hydrated);
  });

  router.post("/notes", requireAuth, (req, res) => {
    const input = noteInput(req.body);
    const result = db
      .prepare("INSERT INTO notes(user_id,title,content,color) VALUES(?,?,?,?)")
      .run(req.user.id, input.title, input.content, input.color);
    const row = accessNote(db, req.user.id, Number(result.lastInsertRowid));
    res.status(201).json(hydrateNote(db, row, req.user.id, req.session));
  });

  router.put(
    "/notes/:id",
    requireAuth,
    asyncRoute(async (req, res) => {
      const access = accessNote(db, req.user.id, Number(req.params.id));
      if (!access || access.permission !== "edit")
        return res.status(403).json({ error: "No edit permission." });
      if (!isUnlocked(req.session, access))
        return res.status(423).json({ error: "Unlock this note first." });
      const baseVersion = Number(req.body.baseVersion);
      if (!Number.isSafeInteger(baseVersion) || baseVersion !== access.version) {
        return conflictResponse(db, res, access, req.user.id, req.session);
      }
      const input = noteInput(req.body, access);
      const result = db
        .prepare(
          `UPDATE notes SET title=?,content=?,color=?,version=version+1,updated_at=CURRENT_TIMESTAMP
           WHERE id=? AND version=? AND deleted_at IS NULL`,
        )
        .run(input.title, input.content, input.color, access.id, baseVersion);
      if (!result.changes) return conflictResponse(db, res, access, req.user.id, req.session);
      const saved = accessNote(db, req.user.id, access.id);
      const hydrated = hydrateNote(db, saved, req.user.id, req.session);
      await realtime.broadcast(access.id, {
        type: "remoteEdit",
        noteId: access.id,
        title: hydrated.title,
        content: hydrated.content,
        color: hydrated.color,
        version: hydrated.version,
        from: req.user.id,
      });
      res.json(hydrated);
    }),
  );

  router.delete(
    "/notes/:id",
    requireAuth,
    requireOwnedNote(db),
    asyncRoute(async (req, res) => {
      if (!isUnlocked(req.session, req.note))
        return res.status(423).json({ error: "Unlock this note first." });
      db.prepare(
        "UPDATE notes SET deleted_at=CURRENT_TIMESTAMP,is_pinned=0,pinned_at=NULL,version=version+1 WHERE id=?",
      ).run(req.note.id);
      await realtime.broadcast(req.note.id, { type: "deleted", noteId: req.note.id });
      await realtime.closeInvalid(req.note.id);
      res.json({ ok: true });
    }),
  );

  router.post(
    "/notes/:id/restore",
    requireAuth,
    requireOwnedNote(db, { deleted: true }),
    (req, res) => {
      db.prepare(
        "UPDATE notes SET deleted_at=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).run(req.note.id);
      res.json({ ok: true });
    },
  );

  router.delete(
    "/notes/:id/permanent",
    requireAuth,
    requireOwnedNote(db, { deleted: true }),
    (req, res) => {
      if (!isUnlocked(req.session, req.note))
        return res.status(423).json({ error: "Unlock this note first." });
      const images = db.prepare("SELECT path FROM note_images WHERE note_id=?").all(req.note.id);
      db.prepare("DELETE FROM notes WHERE id=?").run(req.note.id);
      for (const image of images) removeStoredFile(config.uploadDir, image.path);
      res.json({ ok: true });
    },
  );

  router.post(
    "/notes/:id/unlock",
    requireAuth,
    unlockLimiter,
    asyncRoute(async (req, res) => {
      const access = accessNote(db, req.user.id, Number(req.params.id));
      if (!access) return res.status(404).json({ error: "Note not found." });
      if (
        access.password_hash &&
        !(await bcrypt.compare(String(req.body.password || ""), access.password_hash))
      ) {
        return res.status(401).json({ error: "Wrong note password." });
      }
      req.session.unlockedNotes = req.session.unlockedNotes || {};
      req.session.unlockedNotes[access.id] = access.lock_version;
      res.json({ ok: true });
    }),
  );

  router.post(
    "/notes/:id/password",
    requireAuth,
    requireOwnedNote(db),
    asyncRoute(async (req, res) => {
      if (
        req.note.password_hash &&
        !(await bcrypt.compare(String(req.body.current || ""), req.note.password_hash))
      ) {
        return res.status(401).json({ error: "Current note password is wrong." });
      }
      if (req.body.action === "disable") {
        db.prepare(
          "UPDATE notes SET password_hash=NULL,lock_version=lock_version+1,version=version+1 WHERE id=?",
        ).run(req.note.id);
      } else {
        const password = String(req.body.password || "");
        if (password.length < 8 || password !== String(req.body.confirm || "")) {
          return res
            .status(400)
            .json({ error: "Matching note passwords of at least 8 characters are required." });
        }
        db.prepare(
          "UPDATE notes SET password_hash=?,lock_version=lock_version+1,version=version+1 WHERE id=?",
        ).run(await bcrypt.hash(password, 12), req.note.id);
        req.session.unlockedNotes = req.session.unlockedNotes || {};
        const changed = db.prepare("SELECT lock_version FROM notes WHERE id=?").get(req.note.id);
        req.session.unlockedNotes[req.note.id] = changed.lock_version;
      }
      await realtime.broadcast(req.note.id, { type: "accessChanged", noteId: req.note.id });
      await realtime.closeInvalid(req.note.id);
      res.json({ ok: true });
    }),
  );

  router.post("/notes/:id/pin", requireAuth, requireOwnedNote(db), (req, res) => {
    if (!isUnlocked(req.session, req.note))
      return res.status(423).json({ error: "Unlock this note first." });
    const pinned = req.body.pin ? 1 : 0;
    db.prepare(
      "UPDATE notes SET is_pinned=?,pinned_at=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    ).run(pinned, pinned ? new Date().toISOString() : null, req.note.id);
    res.json({ ok: true });
  });

  const requireEditableUnlocked = (req, res, next) => {
    const access = accessNote(db, req.user.id, Number(req.params.id));
    if (!access || access.permission !== "edit")
      return res.status(403).json({ error: "No edit permission." });
    if (!isUnlocked(req.session, access))
      return res.status(423).json({ error: "Unlock this note first." });
    req.noteAccess = access;
    next();
  };

  router.post(
    "/notes/:id/images",
    requireAuth,
    requireEditableUnlocked,
    imageUpload.array("images", config.maxImagesPerUpload),
    (req, res) => {
      if (!req.files?.length) return res.status(400).json({ error: "Choose at least one image." });
      const stored = [];
      try {
        for (const file of req.files) {
          const filename = persistImage(file, config.uploadDir);
          stored.push(filename);
          db.prepare("INSERT INTO note_images(note_id,path,original_name) VALUES(?,?,?)").run(
            req.noteAccess.id,
            filename,
            text(file.originalname, { max: 255, trim: true }),
          );
        }
      } catch (error) {
        for (const filename of stored) removeStoredFile(config.uploadDir, filename);
        throw error;
      }
      res.status(201).json({ ok: true });
    },
  );

  router.get("/images/:imageId", requireAuth, (req, res) => {
    const image = db
      .prepare(
        "SELECT ni.*,n.id note_id FROM note_images ni JOIN notes n ON n.id=ni.note_id WHERE ni.id=?",
      )
      .get(Number(req.params.imageId));
    if (!image) return res.status(404).json({ error: "Image not found." });
    const access = accessNote(db, req.user.id, image.note_id);
    if (!access) return res.status(404).json({ error: "Image not found." });
    if (!isUnlocked(req.session, access))
      return res.status(423).json({ error: "Unlock this note first." });
    res.setHeader("Cache-Control", "private, no-store");
    const downloadName = path.basename(image.original_name || image.path).replace(/["\r\n]/g, "_");
    res.setHeader("Content-Disposition", `inline; filename="${downloadName}"`);
    res.sendFile(path.join(config.uploadDir, path.basename(image.path)));
  });

  router.delete("/notes/:id/images/:imageId", requireAuth, requireEditableUnlocked, (req, res) => {
    const image = db
      .prepare("SELECT * FROM note_images WHERE id=? AND note_id=?")
      .get(Number(req.params.imageId), req.noteAccess.id);
    if (!image) return res.status(404).json({ error: "Image not found." });
    db.prepare("DELETE FROM note_images WHERE id=?").run(image.id);
    removeStoredFile(config.uploadDir, image.path);
    res.json({ ok: true });
  });

  router.post("/notes/:id/labels", requireAuth, requireOwnedNote(db), (req, res) => {
    if (!isUnlocked(req.session, req.note))
      return res.status(423).json({ error: "Unlock this note first." });
    const labelIds = [
      ...new Set((Array.isArray(req.body.labelIds) ? req.body.labelIds : []).map(Number)),
    ];
    if (labelIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      return res.status(400).json({ error: "Invalid label list." });
    }
    if (labelIds.length) {
      const placeholders = labelIds.map(() => "?").join(",");
      const count = db
        .prepare(`SELECT COUNT(*) count FROM labels WHERE user_id=? AND id IN (${placeholders})`)
        .get(req.user.id, ...labelIds).count;
      if (count !== labelIds.length)
        return res.status(403).json({ error: "A label does not belong to you." });
    }
    db.transaction(() => {
      db.prepare("DELETE FROM note_labels WHERE note_id=?").run(req.note.id);
      const insert = db.prepare("INSERT INTO note_labels(note_id,label_id) VALUES(?,?)");
      for (const labelId of labelIds) insert.run(req.note.id, labelId);
    })();
    res.json({ ok: true });
  });

  router.post(
    "/notes/:id/share",
    requireAuth,
    requireOwnedNote(db),
    asyncRoute(async (req, res) => {
      if (!isUnlocked(req.session, req.note))
        return res.status(423).json({ error: "Unlock this note first." });
      const addresses = [
        ...new Set(
          String(req.body.emails || "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ];
      if (!addresses.length || addresses.length > 20)
        return res.status(400).json({ error: "Enter 1 to 20 email addresses." });
      const permission = req.body.permission === "edit" ? "edit" : "read";
      const missing = [];
      for (const rawAddress of addresses) {
        let address;
        try {
          address = email(rawAddress);
        } catch {
          missing.push(rawAddress);
          continue;
        }
        const recipient = db
          .prepare("SELECT * FROM users WHERE email=? AND is_active=1")
          .get(address);
        if (!recipient || recipient.id === req.user.id) {
          missing.push(address);
          continue;
        }
        db.prepare(
          `INSERT INTO shares(note_id,owner_id,recipient_id,permission) VALUES(?,?,?,?)
           ON CONFLICT(note_id,recipient_id) DO UPDATE SET permission=excluded.permission,created_at=CURRENT_TIMESTAMP`,
        ).run(req.note.id, req.user.id, recipient.id, permission);
        db.prepare("INSERT INTO notifications(user_id,message) VALUES(?,?)").run(
          recipient.id,
          `“${req.note.title}” was shared with ${permission} permission.`,
        );
        await mailer
          .send(
            recipient.email,
            "A NoteVerse note was shared with you",
            `<p>${html(req.user.display_name)} shared “${html(req.note.title)}” with ${permission} permission.</p>`,
          )
          .catch(() => {});
      }
      await realtime.closeInvalid(req.note.id);
      res.json({ ok: true, missing });
    }),
  );

  router.put(
    "/shares/:id",
    requireAuth,
    asyncRoute(async (req, res) => {
      const share = db
        .prepare("SELECT * FROM shares WHERE id=? AND owner_id=?")
        .get(Number(req.params.id), req.user.id);
      if (!share) return res.status(404).json({ error: "Share not found." });
      const permission = req.body.permission === "edit" ? "edit" : "read";
      db.prepare("UPDATE shares SET permission=? WHERE id=?").run(permission, share.id);
      await realtime.closeInvalid(share.note_id);
      res.json({ ok: true });
    }),
  );

  router.delete(
    "/shares/:id",
    requireAuth,
    asyncRoute(async (req, res) => {
      const share = db
        .prepare("SELECT * FROM shares WHERE id=? AND owner_id=?")
        .get(Number(req.params.id), req.user.id);
      if (!share) return res.status(404).json({ error: "Share not found." });
      db.prepare("DELETE FROM shares WHERE id=?").run(share.id);
      await realtime.closeInvalid(share.note_id);
      res.json({ ok: true });
    }),
  );

  router.get("/export", requireAuth, (req, res) => {
    const rows = db
      .prepare("SELECT * FROM notes WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at")
      .all(req.user.id);
    const locked = rows.filter((row) => !isUnlocked(req.session, row)).map((row) => row.id);
    if (locked.length) {
      return res.status(423).json({
        error: "Unlock protected notes before exporting them.",
        lockedNoteIds: locked,
      });
    }
    if (req.query.format === "markdown") {
      const output = rows
        .map(
          (row) =>
            `<!-- noteverse:note -->\n# ${row.title.replace(/[\r\n]+/g, " ")}\n\n${row.content}`,
        )
        .join("\n\n---\n\n");
      res.type("text/markdown");
      res.setHeader("Content-Disposition", "attachment; filename=noteverse-export.md");
      return res.send(output);
    }
    res.setHeader("Content-Disposition", "attachment; filename=noteverse-export.json");
    res.json({
      format: "noteverse",
      version: 1,
      exportedAt: new Date().toISOString(),
      notes: rows.map(({ id, title, content, color: noteColor, created_at, updated_at }) => ({
        sourceId: id,
        title,
        content,
        color: noteColor,
        createdAt: created_at,
        updatedAt: updated_at,
      })),
    });
  });

  router.post("/import", requireAuth, (req, res) => {
    const format = req.body.format === "markdown" ? "markdown" : "json";
    const duplicateStrategy = ["skip", "copy", "replace"].includes(req.body.duplicateStrategy)
      ? req.body.duplicateStrategy
      : "skip";
    let importedNotes = [];
    if (format === "json") {
      let parsed;
      try {
        parsed = typeof req.body.data === "string" ? JSON.parse(req.body.data) : req.body.data;
      } catch {
        return res.status(400).json({ error: "Import file is not valid JSON." });
      }
      if (parsed?.format !== "noteverse" || parsed?.version !== 1 || !Array.isArray(parsed.notes)) {
        return res.status(400).json({ error: "Unsupported NoteVerse JSON format." });
      }
      importedNotes = parsed.notes;
    } else {
      const source = text(req.body.data, { max: 2_000_000 });
      importedNotes = source
        .split(/<!--\s*noteverse:note\s*-->/i)
        .slice(1)
        .map((chunk) => {
          const cleaned = chunk.replace(/^\s*---\s*$/m, "").trim();
          const match = cleaned.match(/^#\s+([^\n]+)\n?([\s\S]*)$/);
          return match ? { title: match[1].trim(), content: match[2].trim() } : null;
        })
        .filter(Boolean);
      if (!importedNotes.length && source.trim())
        importedNotes = [{ title: "Imported note", content: source.trim() }];
    }
    if (!importedNotes.length || importedNotes.length > 1000) {
      return res.status(400).json({ error: "Import must contain between 1 and 1,000 notes." });
    }

    const result = { created: 0, replaced: 0, skipped: 0 };
    db.transaction(() => {
      for (const candidate of importedNotes) {
        const input = noteInput(candidate);
        const duplicate = db
          .prepare(
            "SELECT * FROM notes WHERE user_id=? AND deleted_at IS NULL AND title=? AND content=? LIMIT 1",
          )
          .get(req.user.id, input.title, input.content);
        if (duplicate && duplicateStrategy === "skip") {
          result.skipped += 1;
          continue;
        }
        if (duplicateStrategy === "replace") {
          const sameTitle = db
            .prepare(
              "SELECT * FROM notes WHERE user_id=? AND deleted_at IS NULL AND title=? ORDER BY updated_at DESC LIMIT 1",
            )
            .get(req.user.id, input.title);
          if (sameTitle) {
            if (!isUnlocked(req.session, sameTitle)) {
              result.skipped += 1;
              continue;
            }
            db.prepare(
              "UPDATE notes SET content=?,color=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",
            ).run(input.content, input.color, sameTitle.id);
            result.replaced += 1;
            continue;
          }
        }
        db.prepare("INSERT INTO notes(user_id,title,content,color) VALUES(?,?,?,?)").run(
          req.user.id,
          duplicate && duplicateStrategy === "copy" ? `${input.title} (copy)` : input.title,
          input.content,
          input.color,
        );
        result.created += 1;
      }
    })();
    res.status(201).json(result);
  });
}

module.exports = { noteInput, registerNoteRoutes };
