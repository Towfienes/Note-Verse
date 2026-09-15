const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WebSocket } = require("ws");
const { createApplication } = require("../src/application");

function createClient(baseUrl) {
  let cookie = "";
  return {
    get cookie() {
      return cookie;
    },
    async request(route, { method = "GET", body, headers = {} } = {}) {
      const requestHeaders = new Headers(headers);
      requestHeaders.set("X-NoteVerse-Request", "1");
      if (cookie) requestHeaders.set("Cookie", cookie);
      let requestBody = body;
      if (body && !(body instanceof FormData) && typeof body !== "string") {
        requestHeaders.set("Content-Type", "application/json");
        requestBody = JSON.stringify(body);
      }
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: requestHeaders,
        body: requestBody,
        redirect: "manual",
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      const contentType = response.headers.get("content-type") || "";
      const data = contentType.includes("json")
        ? await response.json()
        : contentType.startsWith("image/")
          ? Buffer.from(await response.arrayBuffer())
          : await response.text();
      return { data, response };
    },
  };
}

async function login(client, email, password = "123456") {
  const result = await client.request("/api/login", { method: "POST", body: { email, password } });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
}

test("authentication, permissions, conflicts, uploads, realtime, trash, and import/export", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "noteverse-test-"));
  const application = createApplication({
    NODE_ENV: "test",
    PORT: "8080",
    APP_BASE_URL: "http://127.0.0.1:8080",
    DATA_DIR: path.join(runtimeDir, "data"),
    UPLOAD_DIR: path.join(runtimeDir, "uploads"),
    DATABASE_PATH: path.join(runtimeDir, "data", "test.sqlite"),
    DEMO_MODE: "true",
    SMTP_ENABLED: "false",
    SESSION_SECRET: "test-secret-that-is-long-enough-for-tests",
  });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const address = application.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => application.server.close(resolve));
    application.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  const noGuard = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@example.com", password: "123456" }),
  });
  assert.equal(noGuard.status, 403, "state-changing APIs require the anti-CSRF request header");

  const newcomer = createClient(baseUrl);
  const registration = await newcomer.request("/api/register", {
    method: "POST",
    body: {
      email: "new@example.com",
      displayName: "New User",
      password: "long-password",
      confirm: "long-password",
    },
  });
  assert.equal(registration.response.status, 201);
  assert.match(registration.data.developmentActivationUrl, /\/api\/activate\//);
  const inactiveLogin = await newcomer.request("/api/login", {
    method: "POST",
    body: { email: "new@example.com", password: "long-password" },
  });
  assert.equal(inactiveLogin.response.status, 403);
  const activationToken = registration.data.developmentActivationUrl.split("/").pop();
  const activation = await newcomer.request(`/api/activate/${activationToken}`);
  assert.equal(activation.response.status, 200);
  await login(newcomer, "new@example.com", "long-password");

  const alice = createClient(baseUrl);
  const bob = createClient(baseUrl);
  const cara = createClient(baseUrl);
  await login(alice, "alice@example.com");
  await login(bob, "bob@example.com");
  await login(cara, "cara@example.com");

  const created = await alice.request("/api/notes", {
    method: "POST",
    body: { title: "Integration note", content: "first", color: "#ffffff" },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.version, 1);
  const noteId = created.data.id;

  const bobLabel = await bob.request("/api/labels", { method: "POST", body: { name: "Bob only" } });
  const foreignLabel = await alice.request(`/api/notes/${noteId}/labels`, {
    method: "POST",
    body: { labelIds: [bobLabel.data.id] },
  });
  assert.equal(foreignLabel.response.status, 403, "owners cannot attach another user's label");

  await alice.request(`/api/notes/${noteId}/share`, {
    method: "POST",
    body: { emails: "bob@example.com", permission: "edit" },
  });
  await alice.request(`/api/notes/${noteId}/share`, {
    method: "POST",
    body: { emails: "cara@example.com", permission: "read" },
  });
  const aliceNotes = await alice.request("/api/notes");
  const sharedNote = aliceNotes.data.find((note) => note.id === noteId);
  const bobShare = sharedNote.shares.find((share) => share.email === "bob@example.com");

  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?noteId=${noteId}`, {
    headers: { Cookie: bob.cookie },
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const closePromise = new Promise((resolve) => ws.once("close", (code) => resolve(code)));
  const downgrade = await alice.request(`/api/shares/${bobShare.id}`, {
    method: "PUT",
    body: { permission: "read" },
  });
  assert.equal(downgrade.response.status, 200);
  assert.equal(
    await closePromise,
    4403,
    "an open editor socket is closed immediately after downgrade",
  );
  await alice.request(`/api/shares/${bobShare.id}`, {
    method: "PUT",
    body: { permission: "edit" },
  });

  const bobSave = await bob.request(`/api/notes/${noteId}`, {
    method: "PUT",
    body: { title: "Integration note", content: "Bob was here", color: "#ffffff", baseVersion: 1 },
  });
  assert.equal(bobSave.response.status, 200);
  assert.equal(bobSave.data.version, 2);
  const staleSave = await alice.request(`/api/notes/${noteId}`, {
    method: "PUT",
    body: { title: "Stale", content: "old", color: "#ffffff", baseVersion: 1 },
  });
  assert.equal(staleSave.response.status, 409);
  assert.equal(staleSave.data.current.content, "Bob was here");
  const readerSave = await cara.request(`/api/notes/${noteId}`, {
    method: "PUT",
    body: { title: "No", content: "No", color: "#ffffff", baseVersion: 2 },
  });
  assert.equal(readerSave.response.status, 403);

  const locked = await alice.request(`/api/notes/${noteId}/password`, {
    method: "POST",
    body: { action: "set", password: "note1234", confirm: "note1234" },
  });
  assert.equal(locked.response.status, 200);
  const bobLockedList = await bob.request("/api/notes");
  const bobLockedNote = bobLockedList.data.find((note) => note.id === noteId);
  assert.equal(bobLockedNote.title, "Protected note");
  assert.equal(bobLockedNote.content, "");
  assert.deepEqual(bobLockedNote.images, []);
  const hiddenSearch = await bob.request("/api/notes?search=Bob%20was%20here");
  assert.ok(
    !hiddenSearch.data.some((note) => note.id === noteId),
    "locked content cannot be inferred through search",
  );

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const beforeFiles = fs.readdirSync(path.join(runtimeDir, "uploads")).length;
  const blockedForm = new FormData();
  blockedForm.append("images", new Blob([png], { type: "image/png" }), "pixel.png");
  const blockedUpload = await bob.request(`/api/notes/${noteId}/images`, {
    method: "POST",
    body: blockedForm,
  });
  assert.equal(blockedUpload.response.status, 423);
  assert.equal(fs.readdirSync(path.join(runtimeDir, "uploads")).length, beforeFiles);
  await bob.request(`/api/notes/${noteId}/unlock`, {
    method: "POST",
    body: { password: "note1234" },
  });
  const imageForm = new FormData();
  imageForm.append("images", new Blob([png], { type: "image/png" }), "pixel.png");
  const upload = await bob.request(`/api/notes/${noteId}/images`, {
    method: "POST",
    body: imageForm,
  });
  assert.equal(upload.response.status, 201);
  const refreshed = await alice.request("/api/notes");
  const image = refreshed.data.find((note) => note.id === noteId).images[0];
  assert.ok(image.url.startsWith("/api/images/"));
  await alice.request(`/api/notes/${noteId}/password`, {
    method: "POST",
    body: {
      action: "set",
      current: "note1234",
      password: "note5678",
      confirm: "note5678",
    },
  });
  const invalidatedUnlock = await bob.request(image.url);
  assert.equal(
    invalidatedUnlock.response.status,
    423,
    "a password change invalidates previous unlocks",
  );
  const lockedImage = await cara.request(image.url);
  assert.equal(lockedImage.response.status, 423);
  await cara.request(`/api/notes/${noteId}/unlock`, {
    method: "POST",
    body: { password: "note5678" },
  });
  const allowedImage = await cara.request(image.url);
  assert.equal(allowedImage.response.status, 200);
  assert.deepEqual(allowedImage.data, png);
  const hiddenImage = await newcomer.request(image.url);
  assert.equal(hiddenImage.response.status, 404);

  const moved = await alice.request(`/api/notes/${noteId}`, { method: "DELETE" });
  assert.equal(moved.response.status, 200);
  const trash = await alice.request("/api/notes?trash=1");
  assert.ok(trash.data.some((note) => note.id === noteId));
  const restored = await alice.request(`/api/notes/${noteId}/restore`, { method: "POST" });
  assert.equal(restored.response.status, 200);

  await alice.request(`/api/notes/${noteId}/password`, {
    method: "POST",
    body: { action: "disable", current: "note5678" },
  });
  const blockedExport = await alice.request("/api/export");
  assert.equal(blockedExport.response.status, 423, "exports cannot bypass a note password");
  const beforeExport = await alice.request("/api/notes");
  const demoProtected = beforeExport.data.find((note) => note.is_locked && !note.is_unlocked);
  await alice.request(`/api/notes/${demoProtected.id}/unlock`, {
    method: "POST",
    body: { password: "note123" },
  });
  const exported = await alice.request("/api/export");
  assert.equal(exported.response.status, 200);
  assert.equal(exported.data.format, "noteverse");
  const imported = await alice.request("/api/import", {
    method: "POST",
    body: { format: "json", data: exported.data, duplicateStrategy: "skip" },
  });
  assert.equal(imported.response.status, 201);
  assert.ok(imported.data.skipped >= 1);
});
