const path = require("path");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { asyncRoute } = require("../middleware");
const { email, hashToken, html, randomToken, text, color } = require("../security");
const { persistImage, removeStoredFile } = require("../uploads");

function regenerateSession(req) {
  return new Promise((resolve, reject) =>
    req.session.regenerate((error) => (error ? reject(error) : resolve())),
  );
}

function destroySession(req) {
  return new Promise((resolve) => req.session.destroy(() => resolve()));
}

function registerAuthRoutes(router, context) {
  const { config, db, mailer, requireAuth, authLimiter, realtime } = context;
  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxImageBytes, files: 1 },
  });

  router.post(
    "/register",
    authLimiter,
    asyncRoute(async (req, res) => {
      const address = email(req.body.email);
      const displayName = text(req.body.displayName, { max: 80, trim: true });
      const password = String(req.body.password || "");
      if (!displayName || password.length < 10 || password !== String(req.body.confirm || "")) {
        return res.status(400).json({
          error: "Display name and matching passwords of at least 10 characters are required.",
        });
      }
      const activationToken = randomToken();
      const activationExpires = Date.now() + 24 * 60 * 60 * 1000;
      try {
        db.prepare(
          `INSERT INTO users(email,display_name,password_hash,activation_token,activation_expires)
           VALUES(?,?,?,?,?)`,
        ).run(
          address,
          displayName,
          await bcrypt.hash(password, 12),
          hashToken(activationToken),
          activationExpires,
        );
      } catch (error) {
        if (String(error.code).startsWith("SQLITE_CONSTRAINT")) {
          return res.status(409).json({ error: "An account with that email already exists." });
        }
        throw error;
      }

      const activationUrl = `${config.baseUrl}/api/activate/${activationToken}`;
      try {
        await mailer.send(
          address,
          "Activate your NoteVerse account",
          `<p>Hello ${html(displayName)},</p><p><a href="${html(activationUrl)}">Activate your account</a>. This link expires in 24 hours.</p>`,
        );
      } catch (error) {
        if (config.isProduction)
          return res
            .status(502)
            .json({ error: "Account created, but activation email could not be sent." });
      }
      res.status(201).json({
        ok: true,
        message: "Account created. Activate it before signing in.",
        ...(config.isProduction ? {} : { developmentActivationUrl: activationUrl }),
      });
    }),
  );

  router.post(
    "/login",
    authLimiter,
    asyncRoute(async (req, res) => {
      let address;
      try {
        address = email(req.body.email);
      } catch {
        return res.status(401).json({ error: "Invalid email or password." });
      }
      const user = db.prepare("SELECT * FROM users WHERE email=?").get(address);
      if (!user || !(await bcrypt.compare(String(req.body.password || ""), user.password_hash))) {
        return res.status(401).json({ error: "Invalid email or password." });
      }
      if (!user.is_active)
        return res.status(403).json({ error: "Activate your account before signing in." });
      await regenerateSession(req);
      req.session.userId = user.id;
      req.session.sessionVersion = user.session_version;
      res.json({ ok: true });
    }),
  );

  router.post(
    "/logout",
    requireAuth,
    asyncRoute(async (req, res) => {
      const userId = req.user.id;
      await destroySession(req);
      realtime.closeUser(userId);
      res.clearCookie("noteverse.sid");
      res.json({ ok: true });
    }),
  );

  router.get("/me", requireAuth, (req, res) => {
    const notifications = db
      .prepare("SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 10")
      .all(req.user.id);
    let preferences = {};
    try {
      preferences = JSON.parse(req.user.preferences || "{}");
    } catch {}
    res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        display_name: req.user.display_name,
        avatar_url: req.user.avatar_path ? `/api/users/${req.user.id}/avatar` : null,
        preferences,
      },
      notifications,
    });
  });

  router.get("/activate/:token", (req, res) => {
    const raw = String(req.params.token || "");
    const user = db
      .prepare(
        `SELECT * FROM users WHERE (activation_token=? OR activation_token=?)
         AND (activation_expires IS NULL OR activation_expires>?)`,
      )
      .get(hashToken(raw), raw, Date.now());
    if (!user)
      return res.status(400).sendFile(path.join(config.publicDir, "activation-invalid.html"));
    db.prepare(
      "UPDATE users SET is_active=1,activation_token=NULL,activation_expires=NULL WHERE id=?",
    ).run(user.id);
    res.sendFile(path.join(config.publicDir, "activation-success.html"));
  });

  router.post(
    "/password/request-reset",
    authLimiter,
    asyncRoute(async (req, res) => {
      let address = "";
      try {
        address = email(req.body.email);
      } catch {}
      const user = address ? db.prepare("SELECT * FROM users WHERE email=?").get(address) : null;
      let developmentResetUrl;
      if (user) {
        const resetToken = randomToken();
        db.prepare("UPDATE users SET reset_token=?,reset_expires=? WHERE id=?").run(
          hashToken(resetToken),
          Date.now() + 60 * 60 * 1000,
          user.id,
        );
        developmentResetUrl = `${config.baseUrl}/reset.html?token=${resetToken}`;
        await mailer
          .send(
            address,
            "Reset your NoteVerse password",
            `<p><a href="${html(developmentResetUrl)}">Reset your password</a>. This link expires in one hour.</p>`,
          )
          .catch(() => {});
      }
      res.json({
        ok: true,
        message: "If that account exists, reset instructions were sent.",
        ...(!config.isProduction && developmentResetUrl ? { developmentResetUrl } : {}),
      });
    }),
  );

  router.post(
    "/password/reset",
    authLimiter,
    asyncRoute(async (req, res) => {
      const raw = String(req.body.token || "");
      const password = String(req.body.password || "");
      const user = db
        .prepare("SELECT * FROM users WHERE (reset_token=? OR reset_token=?) AND reset_expires>?")
        .get(hashToken(raw), raw, Date.now());
      if (!user || password.length < 10 || password !== String(req.body.confirm || "")) {
        return res
          .status(400)
          .json({ error: "The reset link or password confirmation is invalid." });
      }
      db.prepare(
        `UPDATE users SET password_hash=?,reset_token=NULL,reset_expires=NULL,
         session_version=session_version+1 WHERE id=?`,
      ).run(await bcrypt.hash(password, 12), user.id);
      realtime.closeUser(user.id);
      res.json({ ok: true });
    }),
  );

  router.post(
    "/password/change",
    requireAuth,
    asyncRoute(async (req, res) => {
      const complete = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
      const password = String(req.body.password || "");
      if (
        !(await bcrypt.compare(String(req.body.current || ""), complete.password_hash)) ||
        password.length < 10 ||
        password !== String(req.body.confirm || "")
      ) {
        return res
          .status(400)
          .json({ error: "Current password or new password confirmation is invalid." });
      }
      db.prepare(
        "UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=?",
      ).run(await bcrypt.hash(password, 12), req.user.id);
      const updated = db.prepare("SELECT session_version FROM users WHERE id=?").get(req.user.id);
      req.session.sessionVersion = updated.session_version;
      realtime.closeUser(req.user.id);
      res.json({ ok: true });
    }),
  );

  router.put(
    "/profile",
    requireAuth,
    avatarUpload.single("avatar"),
    asyncRoute(async (req, res) => {
      const displayName = text(req.body.displayName, { max: 80, trim: true });
      if (!displayName) return res.status(400).json({ error: "Display name is required." });
      let filename;
      if (req.file) filename = persistImage(req.file, config.uploadDir);
      try {
        db.prepare(
          "UPDATE users SET display_name=?,avatar_path=COALESCE(?,avatar_path) WHERE id=?",
        ).run(displayName, filename || null, req.user.id);
      } catch (error) {
        if (filename) removeStoredFile(config.uploadDir, filename);
        throw error;
      }
      if (filename && req.user.avatar_path)
        removeStoredFile(config.uploadDir, req.user.avatar_path);
      res.json({ ok: true });
    }),
  );

  router.get("/users/:id/avatar", requireAuth, (req, res) => {
    const user = db.prepare("SELECT avatar_path FROM users WHERE id=?").get(Number(req.params.id));
    if (!user?.avatar_path) return res.status(404).json({ error: "Avatar not found." });
    res.setHeader("Cache-Control", "private, no-store");
    res.sendFile(path.join(config.uploadDir, path.basename(user.avatar_path)));
  });

  router.put("/preferences", requireAuth, (req, res) => {
    const fontSize = Math.min(24, Math.max(12, Number(req.body.fontSize) || 16));
    const preferences = {
      fontSize,
      theme: req.body.theme === "dark" ? "dark" : "light",
      defaultColor: color(req.body.defaultColor),
    };
    db.prepare("UPDATE users SET preferences=? WHERE id=?").run(
      JSON.stringify(preferences),
      req.user.id,
    );
    res.json({ ok: true, preferences });
  });

  router.post("/notifications/mark-read", requireAuth, (req, res) => {
    db.prepare("UPDATE notifications SET is_read=1 WHERE user_id=?").run(req.user.id);
    res.json({ ok: true });
  });
}

module.exports = { registerAuthRoutes };
