const crypto = require("crypto");

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function text(value, { max = 10_000, trim = false } = {}) {
  const result = String(value ?? "");
  if (result.length > max)
    throw Object.assign(new Error(`Value exceeds ${max} characters.`), { status: 400 });
  return trim ? result.trim() : result;
}

function email(value) {
  const result = text(value, { max: 254, trim: true }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) {
    throw Object.assign(new Error("Enter a valid email address."), { status: 400 });
  }
  return result;
}

function color(value, fallback = "#ffffff") {
  const result = String(value || fallback);
  return /^#[0-9a-f]{6}$/i.test(result) ? result.toLowerCase() : fallback;
}

function html(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}

function createRateLimiter({ windowMs, limit, key = (req) => req.ip }) {
  const attempts = new Map();
  const timer = setInterval(
    () => {
      const now = Date.now();
      for (const [id, entry] of attempts) if (entry.resetAt <= now) attempts.delete(id);
    },
    Math.min(windowMs, 60_000),
  );
  timer.unref?.();

  return (req, res, next) => {
    const id = key(req);
    const now = Date.now();
    let entry = attempts.get(id);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + windowMs };
    entry.count += 1;
    attempts.set(id, entry);
    res.setHeader("RateLimit-Limit", limit);
    res.setHeader("RateLimit-Remaining", Math.max(0, limit - entry.count));
    if (entry.count > limit) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ error: "Too many attempts. Please try again later." });
    }
    next();
  };
}

function createMutationGuard(allowedOrigin) {
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("origin");
    if (origin && origin !== allowedOrigin)
      return res.status(403).json({ error: "Origin is not allowed." });
    if (req.get("x-noteverse-request") !== "1") {
      return res.status(403).json({ error: "Missing request verification header." });
    }
    next();
  };
}

module.exports = {
  color,
  createMutationGuard,
  createRateLimiter,
  email,
  hashToken,
  html,
  randomToken,
  safeEqual,
  text,
};
