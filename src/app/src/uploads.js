const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TYPES = [
  {
    mime: "image/png",
    ext: ".png",
    matches: (b) => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  },
  {
    mime: "image/jpeg",
    ext: ".jpg",
    matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/gif",
    ext: ".gif",
    matches: (b) => ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("ascii")),
  },
  {
    mime: "image/webp",
    ext: ".webp",
    matches: (b) =>
      b.subarray(0, 4).toString("ascii") === "RIFF" &&
      b.subarray(8, 12).toString("ascii") === "WEBP",
  },
];

function detectImage(buffer) {
  return TYPES.find((type) => type.matches(buffer)) || null;
}

function persistImage(file, uploadDir) {
  const detected = detectImage(file.buffer);
  if (!detected || detected.mime !== file.mimetype) {
    throw Object.assign(new Error("Only valid PNG, JPEG, GIF, and WebP images are accepted."), {
      status: 415,
    });
  }
  const filename = `${Date.now()}-${crypto.randomBytes(12).toString("hex")}${detected.ext}`;
  fs.writeFileSync(path.join(uploadDir, filename), file.buffer, { flag: "wx", mode: 0o600 });
  return filename;
}

function removeStoredFile(uploadDir, storedPath) {
  if (!storedPath) return;
  const filename = path.basename(storedPath);
  if (filename === ".gitkeep") return;
  try {
    fs.unlinkSync(path.join(uploadDir, filename));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function cleanupOrphanUploads(db, uploadDir) {
  const referenced = new Set(
    [
      ...db.prepare("SELECT path FROM note_images").all(),
      ...db.prepare("SELECT avatar_path path FROM users WHERE avatar_path IS NOT NULL").all(),
    ].map((row) => path.basename(row.path)),
  );
  for (const entry of fs.readdirSync(uploadDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name !== ".gitkeep" && !referenced.has(entry.name)) {
      removeStoredFile(uploadDir, entry.name);
    }
  }
}

module.exports = { cleanupOrphanUploads, detectImage, persistImage, removeStoredFile };
