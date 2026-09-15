const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const nodemailer = require("nodemailer");
const { loadConfig } = require("./config");
const { cleanupExpiredSessions, createDatabase, seedDemoData } = require("./database");
const { createRequireAuth } = require("./middleware");
const { attachRealtime } = require("./realtime");
const { createMutationGuard, createRateLimiter } = require("./security");
const { SQLiteSessionStore } = require("./session-store");
const { cleanupOrphanUploads } = require("./uploads");
const { registerAuthRoutes } = require("./routes/auth");
const { registerNoteRoutes } = require("./routes/notes");

function createMailer(config) {
  if (!config.smtp.enabled) return { send: async () => false };
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    ...(config.smtp.user ? { auth: { user: config.smtp.user, pass: config.smtp.password } } : {}),
  });
  return {
    send: async (to, subject, body) => {
      await transport.sendMail({ from: config.smtp.from, to, subject, html: body });
      return true;
    },
  };
}

function createApplication(overrides = {}) {
  const config = loadConfig(overrides);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const db = createDatabase(config);
  if (config.demoMode) seedDemoData(db);
  cleanupExpiredSessions(db);
  cleanupOrphanUploads(db, config.uploadDir);

  const app = express();
  const server = http.createServer(app);
  const sessionParser = session({
    name: "noteverse.sid",
    secret: config.sessionSecret,
    store: new SQLiteSessionStore(db, config.sessionHours * 60 * 60 * 1000),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge: config.sessionHours * 60 * 60 * 1000,
    },
  });
  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          connectSrc: ["'self'", "ws:", "wss:"],
          imgSrc: ["'self'", "data:", "blob:"],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));
  app.use(sessionParser);

  const realtime = attachRealtime({ server, sessionParser, db, baseUrl: config.baseUrl });
  const requireAuth = createRequireAuth(db);
  const authLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    key: (req) => `${req.ip}:${String(req.body?.email || "").toLowerCase()}`,
  });
  const unlockLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    key: (req) => `${req.ip}:${req.user?.id || "anonymous"}:${req.params.id}`,
  });
  const mailer = createMailer(config);
  const context = { config, db, mailer, requireAuth, authLimiter, unlockLimiter, realtime };

  const api = express.Router();
  api.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  api.use(createMutationGuard(config.allowedOrigin));
  registerAuthRoutes(api, context);
  registerNoteRoutes(api, context);
  api.use((_req, res) => res.status(404).json({ error: "API endpoint not found." }));
  app.use("/api", api);

  app.use(
    express.static(config.publicDir, {
      etag: true,
      maxAge: config.isProduction ? "1h" : 0,
      setHeaders: (res, filename) => {
        if (path.basename(filename) === "service-worker.js")
          res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );
  app.get("*", (_req, res) => res.sendFile(path.join(config.publicDir, "index.html")));

  app.use((error, req, res, _next) => {
    const status = error.status || (error.code === "LIMIT_FILE_SIZE" ? 413 : 500);
    if (status >= 500) console.error(error);
    if (req.originalUrl.startsWith("/api/")) {
      return res
        .status(status)
        .json({ error: status >= 500 ? "Unexpected server error." : error.message });
    }
    res.status(status).send("Unexpected server error.");
  });

  const cleanupTimer = setInterval(() => cleanupExpiredSessions(db), 60 * 60 * 1000);
  cleanupTimer.unref?.();
  function close() {
    clearInterval(cleanupTimer);
    realtime.wss.close();
    db.close();
  }

  return { app, close, config, db, realtime, server };
}

module.exports = { createApplication, createMailer };
