const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { renderMarkdown, safeHref } = require("../public/markdown");

test("Markdown preview escapes HTML and blocks unsafe link protocols", () => {
  const result = renderMarkdown(
    '# Hello\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n\n```js\nconst x = "<tag>";\n```',
  );
  assert.doesNotMatch(result, /<img/i);
  assert.match(result, /&lt;img/);
  assert.match(result, /href="#"/);
  assert.match(result, /<pre><code class="language-js">/);
  assert.equal(safeHref("data:text/html,boom"), "#");
});

test("service worker only caches the static shell and account caches are namespaced", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const worker = fs.readFileSync(path.join(publicDir, "service-worker.js"), "utf8");
  const app = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
  assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.doesNotMatch(worker, /cache\.put\(request[\s\S]*\/api\//);
  assert.match(app, /`noteverse:\$\{id\}:\$\{suffix\}`/);
  assert.match(app, /purgeAccount\(id\)/);
  assert.match(app, /note\.is_locked/);
  assert.match(app, /Reconnect to save this protected note/);
});
