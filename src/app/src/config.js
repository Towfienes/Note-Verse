const path = require("path");

function booleanEnv(value, fallback = false) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function integerEnv(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function loadConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const nodeEnv = env.NODE_ENV || "development";
  const port = integerEnv(env.PORT, 8080, "PORT");
  const rootDir = path.resolve(env.APP_ROOT || path.join(__dirname, ".."));
  const dataDir = path.resolve(env.DATA_DIR || path.join(rootDir, "data"));
  const uploadDir = path.resolve(env.UPLOAD_DIR || path.join(rootDir, "uploads"));
  const sessionSecret =
    env.SESSION_SECRET || (nodeEnv === "production" ? "" : "local-development-only-secret");

  if (nodeEnv === "production" && sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters in production.");
  }

  const baseUrl = env.APP_BASE_URL || `http://localhost:${port}`;
  const smtpEnabled = booleanEnv(env.SMTP_ENABLED, Boolean(env.SMTP_HOST));
  if (nodeEnv === "production" && !smtpEnabled) {
    throw new Error(
      "SMTP_ENABLED=true is required in production so account activation can complete.",
    );
  }
  let parsedBase;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw new Error("APP_BASE_URL must be an absolute http(s) URL.");
  }
  if (!["http:", "https:"].includes(parsedBase.protocol)) {
    throw new Error("APP_BASE_URL must use http or https.");
  }

  return {
    nodeEnv,
    isProduction: nodeEnv === "production",
    port,
    baseUrl: parsedBase.origin,
    allowedOrigin: parsedBase.origin,
    rootDir,
    publicDir: path.join(rootDir, "public"),
    dataDir,
    uploadDir,
    databasePath: path.resolve(env.DATABASE_PATH || path.join(dataDir, "noteverse.sqlite")),
    sessionSecret,
    sessionHours: integerEnv(env.SESSION_HOURS, 8, "SESSION_HOURS"),
    cookieSecure: booleanEnv(env.COOKIE_SECURE, nodeEnv === "production"),
    trustProxy: booleanEnv(env.TRUST_PROXY, false),
    demoMode: booleanEnv(env.DEMO_MODE, false),
    smtp: {
      enabled: smtpEnabled,
      host: env.SMTP_HOST || "localhost",
      port: integerEnv(env.SMTP_PORT, 1025, "SMTP_PORT"),
      secure: booleanEnv(env.SMTP_SECURE, false),
      user: env.SMTP_USER || "",
      password: env.SMTP_PASSWORD || "",
      from: env.MAIL_FROM || "NoteVerse <noreply@localhost>",
    },
    maxImageBytes: integerEnv(env.MAX_IMAGE_BYTES, 5 * 1024 * 1024, "MAX_IMAGE_BYTES"),
    maxImagesPerUpload: integerEnv(env.MAX_IMAGES_PER_UPLOAD, 8, "MAX_IMAGES_PER_UPLOAD"),
  };
}

module.exports = { booleanEnv, loadConfig };
