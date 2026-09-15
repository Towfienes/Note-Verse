const { WebSocket, WebSocketServer } = require("ws");
const { accessNote, hydrateNote, isUnlocked } = require("./notes");
const { text } = require("./security");

function reloadSession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session?.reload) return resolve();
    req.session.reload((error) => (error ? reject(error) : resolve()));
  });
}

function attachRealtime({ server, sessionParser, db, baseUrl }) {
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map();

  function removeSocket(ws) {
    rooms.get(String(ws.noteId))?.delete(ws);
    if (rooms.get(String(ws.noteId))?.size === 0) rooms.delete(String(ws.noteId));
  }

  async function currentAccess(ws, needsEdit = false) {
    try {
      await reloadSession(ws.request);
      const userId = ws.request.session?.userId;
      const sessionVersion = ws.request.session?.sessionVersion;
      if (!userId) return null;
      const user = db.prepare("SELECT is_active,session_version FROM users WHERE id=?").get(userId);
      if (!user?.is_active || user.session_version !== sessionVersion) return null;
      const access = accessNote(db, userId, ws.noteId);
      if (!access || (needsEdit && access.permission !== "edit")) return null;
      if (!isUnlocked(ws.request.session, access)) return null;
      return access;
    } catch {
      return null;
    }
  }

  async function broadcast(noteId, message, except = null) {
    const clients = [...(rooms.get(String(noteId)) || [])];
    await Promise.all(
      clients.map(async (ws) => {
        if (ws === except || ws.readyState !== WebSocket.OPEN) return;
        const access = await currentAccess(ws, false);
        if (!access) return ws.close(4403, "Access changed");
        ws.send(JSON.stringify(message));
      }),
    );
  }

  async function closeInvalid(noteId) {
    const clients = [...(rooms.get(String(noteId)) || [])];
    await Promise.all(
      clients.map(async (ws) => {
        if (!(await currentAccess(ws, true))) ws.close(4403, "Permission changed");
      }),
    );
  }

  function closeUser(userId) {
    for (const clients of rooms.values()) {
      for (const ws of clients) if (ws.userId === userId) ws.close(4401, "Signed out");
    }
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, baseUrl);
    if (url.pathname !== "/ws") return socket.destroy();
    sessionParser(req, {}, () => {
      if (!req.session?.userId) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
  });

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url, baseUrl);
    const noteId = Number(url.searchParams.get("noteId"));
    if (!Number.isSafeInteger(noteId) || noteId <= 0) return ws.close(4400, "Invalid note");
    ws.noteId = noteId;
    ws.userId = req.session.userId;
    ws.request = req;
    const access = await currentAccess(ws, true);
    if (!access) return ws.close(4403, "No edit access");

    const roomKey = String(noteId);
    if (!rooms.has(roomKey)) rooms.set(roomKey, new Set());
    rooms.get(roomKey).add(ws);
    ws.send(JSON.stringify({ type: "presence", message: "Realtime collaboration connected." }));

    ws.on("message", async (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return ws.send(JSON.stringify({ type: "error", error: "Invalid message." }));
      }
      if (message.type !== "edit") return;
      const latest = await currentAccess(ws, true);
      if (!latest) return ws.close(4403, "Access changed");
      const baseVersion = Number(message.baseVersion);
      if (!Number.isSafeInteger(baseVersion) || baseVersion !== latest.version) {
        return ws.send(
          JSON.stringify({
            type: "conflict",
            current: hydrateNote(db, latest, ws.userId, req.session),
          }),
        );
      }
      try {
        const title = text(message.title, { max: 200, trim: true }) || "Untitled";
        const content = text(message.content, { max: 500_000 });
        const result = db
          .prepare(
            `UPDATE notes SET title=?,content=?,version=version+1,updated_at=CURRENT_TIMESTAMP
             WHERE id=? AND version=? AND deleted_at IS NULL`,
          )
          .run(title, content, noteId, baseVersion);
        if (!result.changes) return ws.send(JSON.stringify({ type: "conflict" }));
        const saved = db.prepare("SELECT * FROM notes WHERE id=?").get(noteId);
        ws.send(JSON.stringify({ type: "saved", noteId, version: saved.version }));
        await broadcast(
          noteId,
          { type: "remoteEdit", noteId, title, content, version: saved.version, from: ws.userId },
          ws,
        );
      } catch (error) {
        ws.send(JSON.stringify({ type: "error", error: error.message }));
      }
    });
    ws.on("close", () => removeSocket(ws));
  });

  return { broadcast, closeInvalid, closeUser, rooms, wss };
}

module.exports = { attachRealtime };
