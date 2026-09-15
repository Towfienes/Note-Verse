let me = null;
let notes = [];
let labels = [];
let current = null;
let scope = "all";
let view = "grid";
let socket = null;
let searchTimer = null;
let saveTimer = null;
let refreshTimer = null;
let toastTimer = null;
let saving = false;
let saveAgain = false;
let draftDirty = false;
let currentConflict = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const { escapeHtml: esc, renderMarkdown } = window.NoteVerseMarkdown;

class ApiError extends Error {
  constructor(message, status, data = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-NoteVerse-Request", "1");
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  let response;
  try {
    response = await fetch(url, { credentials: "same-origin", ...options, headers });
  } catch (error) {
    throw new ApiError(error.message || "Network request failed.", 0);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      data.error || response.statusText || "Request failed.",
      response.status,
      data,
    );
  return data;
}

function accountKey(suffix, id = me?.id) {
  return id ? `noteverse:${id}:${suffix}` : null;
}

function readJson(key, fallback) {
  if (!key) return fallback;
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    showToast("This browser could not save the offline copy.", true);
  }
}

function cacheAccount() {
  if (!me) return;
  writeJson(accountKey("profile"), me);
  localStorage.setItem("noteverse:lastUserId", String(me.id));
}

function noteCacheKey() {
  return accountKey(scope === "trash" ? "notes:trash" : "notes:active");
}

function cacheNotes(replace = false) {
  const safeNotes = notes.map((note) =>
    note.is_locked
      ? {
          ...note,
          title: "Protected note",
          content: "",
          labels: [],
          images: [],
          is_unlocked: false,
        }
      : note,
  );
  if (replace) return writeJson(noteCacheKey(), safeNotes);
  const merged = new Map(readJson(noteCacheKey(), []).map((note) => [note.id, note]));
  for (const note of safeNotes) merged.set(note.id, note);
  writeJson(noteCacheKey(), [...merged.values()]);
}

function queuedEdits() {
  return readJson(accountKey("edits"), {});
}

function saveQueue(queue) {
  writeJson(accountKey("edits"), queue);
  updateSyncState();
}

function purgeAccount(id) {
  if (!id) return;
  for (const suffix of ["profile", "notes:active", "notes:trash", "edits", "scope", "view"]) {
    localStorage.removeItem(accountKey(suffix, id));
  }
  if (localStorage.getItem("noteverse:lastUserId") === String(id))
    localStorage.removeItem("noteverse:lastUserId");
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  const box = $("#toast");
  box.textContent = message;
  box.classList.remove("hidden");
  box.style.background = isError ? "#8f2136" : "#24212f";
  toastTimer = setTimeout(() => box.classList.add("hidden"), 4500);
}

function showAuthTab(name) {
  const titles = {
    login: "Sign in to NoteVerse",
    register: "Create your account",
    forgot: "Reset your password",
  };
  $$(".auth-form").forEach((form) => form.classList.add("hidden"));
  $(`#${name}Form`).classList.remove("hidden");
  $$("[data-auth-tab]").forEach((button) =>
    button.setAttribute("aria-selected", String(button.dataset.authTab === name)),
  );
  $("#authTitle").textContent = titles[name];
  $("#authMsg").textContent = "";
}

function networkError(error) {
  return error.status === 0 || !navigator.onLine;
}

function updateSyncState(message = "") {
  const count = Object.keys(queuedEdits()).length;
  const offline = !navigator.onLine;
  const label =
    message ||
    (offline
      ? "Offline"
      : count
        ? `${count} draft${count === 1 ? "" : "s"} waiting`
        : "Up to date");
  const element = $("#syncState");
  if (element) {
    element.textContent = label;
    element.classList.toggle("busy", offline || count > 0 || saving);
    element.classList.toggle("error", Boolean(currentConflict));
  }
  $("#offline")?.classList.toggle("hidden", !offline && count === 0);
  $("#mobileSync")?.classList.toggle("error", offline || count > 0);
}

function applyQueued(list) {
  const queue = queuedEdits();
  return list.map((note) =>
    queue[note.id] ? { ...note, ...queue[note.id], offlineQueued: true } : note,
  );
}

function patchNote(id, patch) {
  notes = notes.map((note) => (note.id === id ? { ...note, ...patch } : note));
  if (current?.id === id) current = { ...current, ...patch };
  cacheNotes();
}

function queueDraft(note, body) {
  if (note.is_locked) return false;
  const queue = queuedEdits();
  queue[note.id] = {
    id: note.id,
    title: body.title,
    content: body.content,
    color: body.color,
    baseVersion: note.version,
    queuedAt: new Date().toISOString(),
  };
  saveQueue(queue);
  patchNote(note.id, { ...body, offlineQueued: true });
  return true;
}

function removeQueuedDraft(noteId) {
  const queue = queuedEdits();
  delete queue[noteId];
  saveQueue(queue);
}

async function syncOfflineEdits() {
  if (!navigator.onLine || !me) return updateSyncState();
  const entries = Object.values(queuedEdits());
  if (!entries.length) return updateSyncState();
  updateSyncState(`Syncing ${entries.length} draft${entries.length === 1 ? "" : "s"}…`);
  for (const edit of entries) {
    try {
      const saved = await api(`/api/notes/${edit.id}`, {
        method: "PUT",
        body: JSON.stringify({
          title: edit.title,
          content: edit.content,
          color: edit.color,
          baseVersion: edit.baseVersion,
        }),
      });
      removeQueuedDraft(edit.id);
      patchNote(edit.id, { ...saved, offlineQueued: false });
    } catch (error) {
      if (networkError(error)) break;
      if (error.status === 409) {
        if (current?.id === edit.id) showConflict(edit, error.data.current);
        showToast(`Draft “${edit.title}” needs conflict review.`, true);
      } else {
        showToast(`Draft “${edit.title}” is still saved locally: ${error.message}`, true);
      }
    }
  }
  updateSyncState();
  renderNotes();
}

async function checkMe() {
  try {
    const data = await api("/api/me");
    me = data.user;
    cacheAccount();
    scope = localStorage.getItem(accountKey("scope")) || "all";
    view = localStorage.getItem(accountKey("view")) || "grid";
    showApplication(data.notifications || []);
    await loadLabels();
    await loadNotes();
    await syncOfflineEdits();
    startRefresh();
  } catch (error) {
    const lastId = localStorage.getItem("noteverse:lastUserId");
    const cachedProfile = readJson(accountKey("profile", lastId), null);
    if (networkError(error) && cachedProfile) {
      me = cachedProfile;
      scope = localStorage.getItem(accountKey("scope")) || "all";
      view = localStorage.getItem(accountKey("view")) || "grid";
      labels = [];
      notes = applyQueued(readJson(noteCacheKey(), []));
      showApplication([]);
      renderNotes();
      updateSyncState();
    } else {
      if (error.status === 401 && lastId) purgeAccount(lastId);
      me = null;
      $("#auth").classList.remove("hidden");
      $("#app").classList.add("hidden");
    }
  }
}

function showApplication(notifications) {
  $("#auth").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#userName").textContent = me.display_name;
  $("#userEmail").textContent = me.email;
  $("#userAvatar").src = me.avatar_url || "/icon.svg";
  document.body.classList.toggle("dark", me.preferences?.theme === "dark");
  document.body.style.fontSize = `${me.preferences?.fontSize || 16}px`;
  renderNotifications(notifications);
  updateSyncState();
}

function startRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (me && navigator.onLine && !document.hidden && !draftDirty && !currentConflict) loadNotes();
  }, 15_000);
}

function renderNotifications(items) {
  const unread = items.filter((item) => !item.is_read);
  $("#notifications").innerHTML = unread
    .map((item) => `<div class="notification">${esc(item.message)}</div>`)
    .join("");
  if (unread.length) {
    api("/api/notifications/mark-read", { method: "POST" }).catch(() => {});
    setTimeout(() => {
      $("#notifications").innerHTML = "";
    }, 6000);
  }
}

async function loadLabels() {
  if (!navigator.onLine) return;
  labels = await api("/api/labels");
  renderLabels();
}

function renderLabels() {
  const active = new URLSearchParams(location.search).get("label") || "";
  $("#labels").innerHTML =
    `<button type="button" class="label-filter ${active ? "" : "active"}" data-label-filter="">All labels</button>` +
    labels
      .map(
        (label) =>
          `<div class="label-row"><button type="button" class="label-filter ${String(label.id) === active ? "active" : ""}" data-label-filter="${label.id}"># ${esc(label.name)}</button><button type="button" class="label-more" data-label-menu="${label.id}" aria-label="Label options for ${esc(label.name)}">•••</button></div>`,
      )
      .join("");
  renderLabelChecks();
}

async function loadNotes() {
  const params = new URLSearchParams();
  const search = $("#search").value.trim();
  const label = new URLSearchParams(location.search).get("label");
  if (search) params.set("search", search);
  if (label && scope !== "trash") params.set("label", label);
  if (scope === "trash") params.set("trash", "1");
  try {
    const loaded = await api(`/api/notes?${params}`);
    notes = applyQueued(loaded);
    cacheNotes(!search && !label);
    refreshCurrent();
    renderNotes();
  } catch (error) {
    if (networkError(error)) {
      notes = applyQueued(readJson(noteCacheKey(), []));
      refreshCurrent();
      renderNotes();
      updateSyncState();
    } else showToast(error.message, true);
  }
}

function visibleNotes() {
  if (scope === "mine") return notes.filter((note) => note.role === "owner" && !note.deleted_at);
  if (scope === "shared") return notes.filter((note) => note.role === "shared" && !note.deleted_at);
  if (scope === "trash") return notes.filter((note) => note.deleted_at);
  return notes.filter((note) => !note.deleted_at);
}

function relativeTime(value) {
  const time = new Date(value).getTime();
  const seconds = Math.max(1, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function noteIcons(note) {
  return `${note.is_pinned ? "●" : ""}${note.is_locked ? " ◈" : ""}${note.role === "shared" ? " ◇" : ""}`.trim();
}

function renderNotes() {
  const titles = {
    all: ["All notes", "Everything you’re working on, in one place."],
    mine: ["My notes", "Notes you own and control."],
    shared: ["Shared with me", "Ideas your collaborators invited you into."],
    trash: ["Trash", "Restore notes or remove them permanently."],
  };
  $("#scopeTitle").textContent = titles[scope]?.[0] || titles.all[0];
  $("#scopeSubtitle").textContent = titles[scope]?.[1] || titles.all[1];
  $$("[data-scope]").forEach((button) =>
    button.classList.toggle("active", button.dataset.scope === scope),
  );
  $("#gridBtn").classList.toggle("active", view === "grid");
  $("#listBtn").classList.toggle("active", view === "list");
  $("#allCount").textContent =
    scope === "trash" ? "" : notes.filter((note) => !note.deleted_at).length;
  const list = visibleNotes();
  const box = $("#notes");
  box.className = `notes ${view}`;
  box.innerHTML = list.length
    ? list
        .map((note) => {
          const preview =
            note.is_locked && !note.is_unlocked
              ? "Unlock to view this note."
              : note.content || "No content yet.";
          const trashActions =
            scope === "trash"
              ? `<div class="chips"><button type="button" data-restore="${note.id}">Restore</button><button type="button" class="danger-text" data-purge="${note.id}">Delete forever</button></div>`
              : "";
          return `<article class="note-card" data-note-id="${note.id}" tabindex="0" role="button" style="background:${esc(note.color || "#ffffff")}"><div class="icons">${esc(noteIcons(note))}</div><h2>${esc(note.title || "Untitled")}</h2><p>${esc(preview)}</p><div class="chips">${(note.labels || []).map((label) => `<span class="chip">${esc(label.name)}</span>`).join("")}${note.role === "shared" ? `<span class="chip">${note.permission === "edit" ? "Can edit" : "Read only"}</span>` : ""}${note.offlineQueued ? '<span class="chip warning">Local draft</span>' : ""}</div><div class="note-meta"><span>${note.deleted_at ? "Deleted" : "Edited"} ${relativeTime(note.deleted_at || note.updated_at)}</span><span>v${note.version}</span></div>${trashActions}</article>`;
        })
        .join("")
    : `<div class="empty-state"><div><span>${scope === "trash" ? "♲" : "✦"}</span><b>${scope === "trash" ? "Trash is empty" : "No notes here yet"}</b><p>${scope === "trash" ? "Deleted notes will appear here." : "Create a note and give the idea somewhere to grow."}</p></div></div>`;
}

function refreshCurrent() {
  if (!current || draftDirty || currentConflict) return;
  const refreshed = notes.find((note) => note.id === current.id);
  if (!refreshed) return;
  current = refreshed;
  fillEditor();
}

async function openNote(id) {
  if (scope === "trash") return;
  if (current?.id !== id && (await saveCurrent()) === false) {
    return showToast("Reconnect to save this protected note before leaving it.", true);
  }
  current = notes.find((note) => note.id === id);
  if (!current) return;
  if (current.is_locked && !current.is_unlocked) {
    const password = prompt("Enter this note’s password:");
    if (!password) return;
    try {
      await api(`/api/notes/${id}/unlock`, { method: "POST", body: JSON.stringify({ password }) });
      await loadNotes();
      current = notes.find((note) => note.id === id);
    } catch (error) {
      return showToast(error.message, true);
    }
  }
  draftDirty = false;
  currentConflict = null;
  $("#conflictNotice").classList.add("hidden");
  $("#editor").classList.remove("hidden");
  fillEditor();
  connectRealtime();
  $("#noteTitle").focus();
}

function fillEditor() {
  if (!current) return;
  $("#noteTitle").value = current.title || "";
  $("#noteContent").value = current.content || "";
  $("#noteIcons").textContent = noteIcons(current);
  $("#markdownPreview").innerHTML = renderMarkdown(current.content || "");
  applyPermissions();
  renderImages();
  renderShares();
  renderLabelChecks();
}

function canEdit() {
  return current?.permission === "edit";
}
function isOwner() {
  return current?.role === "owner";
}

function applyPermissions() {
  const editable = canEdit();
  $("#noteTitle").disabled = !editable;
  $("#noteContent").disabled = !editable;
  $("#readOnlyNotice").classList.toggle("hidden", editable);
  $("#imageBtn").classList.toggle("hidden", !editable);
  for (const selector of ["#pinBtn", "#noteLabelsBtn", "#lockBtn", "#shareBtn", "#deleteBtn"]) {
    $(selector).classList.toggle("hidden", !isOwner());
  }
  $("#pinBtn").textContent = current.is_pinned ? "Unpin" : "Pin";
  $("#saveState").textContent = editable
    ? current.offlineQueued
      ? "Local draft"
      : "Ready"
    : "Read only";
}

function renderImages() {
  $("#imageList").innerHTML = (current?.images || [])
    .map(
      (image) =>
        `<figure class="image-thumb"><img src="${esc(image.url)}" alt="${esc(image.original_name || "Note attachment")}" />${canEdit() ? `<button type="button" class="image-delete" data-delete-image="${image.id}">Remove</button>` : ""}</figure>`,
    )
    .join("");
}

function renderShares() {
  if (!current) return;
  const incoming = current.incoming
    ? `<p>Shared by <b>${esc(current.incoming.owner_name)}</b> (${esc(current.incoming.owner_email)}) · ${current.incoming.permission === "edit" ? "Can edit" : "Read only"}</p>`
    : "";
  const recipients = isOwner()
    ? (current.shares || [])
        .map(
          (share) =>
            `<div class="share-recipient"><span>${esc(share.email)}</span><select data-share-permission="${share.id}" aria-label="Permission for ${esc(share.email)}"><option value="read" ${share.permission === "read" ? "selected" : ""}>Read only</option><option value="edit" ${share.permission === "edit" ? "selected" : ""}>Can edit</option></select><button type="button" data-revoke-share="${share.id}">Revoke</button></div>`,
        )
        .join("")
    : "";
  $("#shareList").innerHTML = incoming + recipients;
  $("#ownerShares").innerHTML = recipients || '<p class="muted">No recipients yet.</p>';
}

function renderLabelChecks() {
  if (!current) return;
  const selected = new Set((current.labels || []).map((label) => label.id));
  $("#labelChecks").innerHTML = labels.length
    ? labels
        .map(
          (label) =>
            `<label class="check-row"><span>${esc(label.name)}</span><input type="checkbox" value="${label.id}" ${selected.has(label.id) ? "checked" : ""} /></label>`,
        )
        .join("")
    : '<p class="muted">Create a label first.</p>';
}

function draftBody() {
  return { title: $("#noteTitle").value, content: $("#noteContent").value, color: current.color };
}

function scheduleSave() {
  if (!current || !canEdit()) return;
  draftDirty = true;
  patchNote(current.id, draftBody());
  clearTimeout(saveTimer);
  $("#saveState").textContent = navigator.onLine ? "Unsaved" : "Saved locally";
  saveTimer = setTimeout(saveCurrent, 550);
}

async function saveCurrent() {
  clearTimeout(saveTimer);
  if (!current || !canEdit() || !draftDirty || currentConflict) return true;
  if (saving) {
    saveAgain = true;
    return true;
  }
  saving = true;
  updateSyncState("Saving…");
  do {
    saveAgain = false;
    const note = current;
    const body = draftBody();
    draftDirty = false;
    patchNote(note.id, body);
    if (!navigator.onLine) {
      if (queueDraft(note, body)) {
        $("#saveState").textContent = "Saved locally";
      } else {
        draftDirty = true;
        $("#saveState").textContent = "Reconnect to save protected note";
        saving = false;
        updateSyncState();
        return false;
      }
      break;
    }
    try {
      const saved = await api(`/api/notes/${note.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...body, baseVersion: note.version }),
      });
      removeQueuedDraft(note.id);
      patchNote(note.id, { ...saved, offlineQueued: false });
      if (current?.id === note.id) $("#saveState").textContent = "Saved";
    } catch (error) {
      if (networkError(error)) {
        queueDraft(note, body);
        $("#saveState").textContent = "Saved locally";
      } else if (error.status === 409) {
        queueDraft(note, body);
        showConflict(body, error.data.current);
      } else {
        draftDirty = true;
        queueDraft(note, body);
        $("#saveState").textContent = "Draft kept locally";
        showToast(error.message, true);
      }
    }
  } while ((saveAgain || draftDirty) && current && !currentConflict);
  saving = false;
  updateSyncState();
  renderNotes();
  return true;
}

function showConflict(mine, server) {
  currentConflict = { mine: { ...mine }, server };
  $("#conflictNotice").classList.remove("hidden");
  $("#saveState").textContent = "Conflict";
  updateSyncState("Conflict needs review");
}

function useServerVersion() {
  if (!currentConflict?.server) return;
  removeQueuedDraft(current.id);
  patchNote(current.id, { ...currentConflict.server, offlineQueued: false });
  current = notes.find((note) => note.id === current.id);
  currentConflict = null;
  draftDirty = false;
  $("#conflictNotice").classList.add("hidden");
  fillEditor();
  updateSyncState();
}

async function keepMine() {
  if (!currentConflict?.server) return;
  const mine = currentConflict.mine;
  current.version = currentConflict.server.version;
  currentConflict = null;
  $("#conflictNotice").classList.add("hidden");
  $("#noteTitle").value = mine.title;
  $("#noteContent").value = mine.content;
  draftDirty = true;
  await saveCurrent();
}

async function closeEditor() {
  if ((await saveCurrent()) === false) return false;
  socket?.close();
  socket = null;
  current = null;
  currentConflict = null;
  $("#editor").classList.add("hidden");
  return true;
}

function connectRealtime() {
  socket?.close();
  if (!current || !canEdit() || !navigator.onLine) return;
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?noteId=${current.id}`,
  );
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.from === me?.id || message.noteId !== current?.id) return;
    if (message.type === "remoteEdit") {
      if (
        draftDirty ||
        current?.offlineQueued ||
        [$("#noteTitle"), $("#noteContent")].includes(document.activeElement)
      ) {
        showConflict(draftBody(), { ...current, ...message });
      } else {
        patchNote(current.id, message);
        fillEditor();
        $("#saveState").textContent = "Updated by collaborator";
        renderNotes();
      }
    }
    if (["accessChanged", "deleted"].includes(message.type)) {
      showToast("Access to this note changed. Refreshing…");
      closeEditor().then(loadNotes);
    }
  };
  socket.onclose = (event) => {
    if (event.code === 4403 && current) {
      showToast("Your collaboration permission changed.", true);
      closeEditor().then(loadNotes);
    }
  };
}

function openPanel(id) {
  if (["noteLabelPanel", "lockPanel", "sharePanel"].includes(id) && current && !isOwner())
    return showToast("Only the owner can use that action.", true);
  if (id === "imagePanel" && current && !canEdit())
    return showToast("This note is read-only.", true);
  $$(".panel").forEach((panel) => panel.classList.add("hidden"));
  $(`#${id}`).classList.remove("hidden");
  $("#modal").classList.remove("hidden");
  $("#modalMsg").textContent = "";
  if (id === "profilePanel") {
    $("#profileForm").displayName.value = me.display_name;
    $("#profileAvatarPreview").src = me.avatar_url || "/icon.svg";
  }
  if (id === "prefsPanel") {
    $("#prefsForm").fontSize.value = me.preferences?.fontSize || 16;
    $("#prefsForm").theme.value = me.preferences?.theme || "light";
    $("#prefsForm").defaultColor.value = me.preferences?.defaultColor || "#ffffff";
  }
  if (id === "noteLabelPanel") renderLabelChecks();
  if (id === "lockPanel") configureLockPanel();
  if (id === "sharePanel") renderShares();
  $(`#${id} input, #${id} select`)?.focus();
}

function closePanel() {
  $("#modal").classList.add("hidden");
}

function configureLockPanel() {
  const protectedNote = Boolean(current?.is_locked);
  $("#lockForm").reset();
  $("#lockDisableForm").reset();
  $("#lockCurrentLabel").classList.toggle("hidden", !protectedNote);
  $("#lockDisableForm").classList.toggle("hidden", !protectedNote);
  $("#lockSetBtn").textContent = protectedNote ? "Change password" : "Enable password";
  $("#lockHint").textContent = protectedNote
    ? "Enter the current password before changing or disabling protection."
    : "Set a password of at least 8 characters.";
}

async function downloadExport(format) {
  try {
    const response = await fetch(`/api/export?format=${format}`, {
      credentials: "same-origin",
      headers: { "X-NoteVerse-Request": "1" },
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Export failed.");
    }
    const blob = await response.blob();
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `noteverse-export.${format === "markdown" ? "md" : "json"}`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function boot() {
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  window.addEventListener("online", async () => {
    await checkMe();
    await saveCurrent();
    await syncOfflineEdits();
  });
  window.addEventListener("offline", updateSyncState);
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "/" &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)
    ) {
      event.preventDefault();
      $("#search").focus();
    }
    if (event.key === "Escape") {
      if (!$("#modal").classList.contains("hidden")) closePanel();
      else if (!$("#editor").classList.contains("hidden")) closeEditor();
    }
  });
  await checkMe();
}

$$("[data-auth-tab]").forEach((button) =>
  button.addEventListener("click", () => showAuthTab(button.dataset.authTab)),
);
$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
    });
    await checkMe();
  } catch (error) {
    $("#authMsg").textContent = error.message;
  }
});
$("#registerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/register", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
    });
    $("#authMsg").textContent = data.developmentActivationUrl
      ? `${data.message} Development link: ${data.developmentActivationUrl}`
      : data.message;
  } catch (error) {
    $("#authMsg").textContent = error.message;
  }
});
$("#forgotForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/password/request-reset", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
    });
    $("#authMsg").textContent = data.developmentResetUrl
      ? `${data.message} Development link: ${data.developmentResetUrl}`
      : data.message;
  } catch (error) {
    $("#authMsg").textContent = error.message;
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  const id = me?.id;
  try {
    await api("/api/logout", { method: "POST" });
  } finally {
    purgeAccount(id);
    navigator.serviceWorker.controller?.postMessage({ type: "PURGE_PRIVATE" });
    location.reload();
  }
});
$("#newNoteBtn").addEventListener("click", async () => {
  try {
    await saveCurrent();
    const note = await api("/api/notes", {
      method: "POST",
      body: JSON.stringify({
        title: "Untitled",
        content: "",
        color: me.preferences?.defaultColor || "#ffffff",
      }),
    });
    scope = "mine";
    localStorage.setItem(accountKey("scope"), scope);
    $("#search").value = "";
    history.replaceState(null, "", location.pathname);
    await loadNotes();
    openNote(note.id);
  } catch (error) {
    showToast(error.message, true);
  }
});
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadNotes, 300);
});
$$("[data-scope]").forEach((button) =>
  button.addEventListener("click", async () => {
    if ((await saveCurrent()) === false) return;
    scope = button.dataset.scope;
    localStorage.setItem(accountKey("scope"), scope);
    history.replaceState(null, "", location.pathname);
    await closeEditor();
    await loadNotes();
    $("#sidebar").classList.remove("open");
  }),
);
$("#gridBtn").addEventListener("click", () => {
  view = "grid";
  localStorage.setItem(accountKey("view"), view);
  renderNotes();
});
$("#listBtn").addEventListener("click", () => {
  view = "list";
  localStorage.setItem(accountKey("view"), view);
  renderNotes();
});
$("#menuBtn").addEventListener("click", () => {
  $("#sidebar").classList.add("open");
  $("#menuBtn").setAttribute("aria-expanded", "true");
});
$("#sidebarClose").addEventListener("click", () => {
  $("#sidebar").classList.remove("open");
  $("#menuBtn").setAttribute("aria-expanded", "false");
});
$("#accountBtn").addEventListener("click", () => {
  const hidden = $("#accountPopover").classList.toggle("hidden");
  $("#accountBtn").setAttribute("aria-expanded", String(!hidden));
});
$("#themeBtn").addEventListener("click", async () => {
  const theme = document.body.classList.contains("dark") ? "light" : "dark";
  document.body.classList.toggle("dark", theme === "dark");
  try {
    const data = await api("/api/preferences", {
      method: "PUT",
      body: JSON.stringify({ ...me.preferences, theme }),
    });
    me.preferences = data.preferences;
    cacheAccount();
  } catch (error) {
    showToast(error.message, true);
  }
});
$("#addLabelBtn").addEventListener("click", () => {
  $("#labelForm").classList.toggle("hidden");
  $("#newLabelName").focus();
});

$("#notes").addEventListener("click", async (event) => {
  const restore = event.target.closest("[data-restore]");
  const purge = event.target.closest("[data-purge]");
  if (restore) {
    await api(`/api/notes/${restore.dataset.restore}/restore`, { method: "POST" });
    return loadNotes();
  }
  if (purge) {
    if (confirm("Delete this note and its attachments forever?")) {
      await api(`/api/notes/${purge.dataset.purge}/permanent`, { method: "DELETE" });
      await loadNotes();
    }
    return;
  }
  const card = event.target.closest("[data-note-id]");
  if (card) openNote(Number(card.dataset.noteId));
});
$("#notes").addEventListener("keydown", (event) => {
  if (["Enter", " "].includes(event.key) && event.target.matches("[data-note-id]")) {
    event.preventDefault();
    openNote(Number(event.target.dataset.noteId));
  }
});
$("#labels").addEventListener("click", async (event) => {
  const filter = event.target.closest("[data-label-filter]");
  if (filter) {
    const params = new URLSearchParams(location.search);
    if (filter.dataset.labelFilter) params.set("label", filter.dataset.labelFilter);
    else params.delete("label");
    history.replaceState(null, "", params.toString() ? `?${params}` : location.pathname);
    renderLabels();
    return loadNotes();
  }
  const menu = event.target.closest("[data-label-menu]");
  if (menu) {
    const id = Number(menu.dataset.labelMenu);
    const label = labels.find((item) => item.id === id);
    const name = prompt("Rename this label, or leave blank to delete it:", label?.name || "");
    if (name === null) return;
    if (!name.trim()) {
      if (confirm("Delete this label? Notes will stay intact."))
        await api(`/api/labels/${id}`, { method: "DELETE" });
    } else await api(`/api/labels/${id}`, { method: "PUT", body: JSON.stringify({ name }) });
    await loadLabels();
    await loadNotes();
  }
});
$("#labelForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/labels", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
    });
    event.currentTarget.reset();
    event.currentTarget.classList.add("hidden");
    await loadLabels();
  } catch (error) {
    showToast(error.message, true);
  }
});

$("#noteTitle").addEventListener("input", scheduleSave);
$("#noteContent").addEventListener("input", scheduleSave);
$("#closeEditorBtn").addEventListener("click", closeEditor);
$("#writeTab").addEventListener("click", () => {
  $("#writeTab").classList.add("active");
  $("#previewTab").classList.remove("active");
  $("#noteContent").classList.remove("hidden");
  $("#markdownPreview").classList.add("hidden");
});
$("#previewTab").addEventListener("click", () => {
  $("#markdownPreview").innerHTML = renderMarkdown($("#noteContent").value);
  $("#previewTab").classList.add("active");
  $("#writeTab").classList.remove("active");
  $("#noteContent").classList.add("hidden");
  $("#markdownPreview").classList.remove("hidden");
});
$("#useServerBtn").addEventListener("click", useServerVersion);
$("#keepMineBtn").addEventListener("click", keepMine);
$("#pinBtn").addEventListener("click", async () => {
  await saveCurrent();
  await api(`/api/notes/${current.id}/pin`, {
    method: "POST",
    body: JSON.stringify({ pin: !current.is_pinned }),
  });
  await loadNotes();
  current = notes.find((note) => note.id === current.id);
  fillEditor();
});
$("#deleteBtn").addEventListener("click", async () => {
  if (!confirm("Move this note to trash?")) return;
  await api(`/api/notes/${current.id}`, { method: "DELETE" });
  await closeEditor();
  await loadNotes();
});
$("#imageList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-image]");
  if (!button || !confirm("Remove this image?")) return;
  await api(`/api/notes/${current.id}/images/${button.dataset.deleteImage}`, { method: "DELETE" });
  await loadNotes();
  current = notes.find((note) => note.id === current.id);
  fillEditor();
});
$("#shareList").addEventListener("change", async (event) => {
  if (!event.target.matches("[data-share-permission]")) return;
  await api(`/api/shares/${event.target.dataset.sharePermission}`, {
    method: "PUT",
    body: JSON.stringify({ permission: event.target.value }),
  });
  await loadNotes();
  current = notes.find((note) => note.id === current.id);
  fillEditor();
});
$("#shareList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-revoke-share]");
  if (!button || !confirm("Revoke this person’s access?")) return;
  await api(`/api/shares/${button.dataset.revokeShare}`, { method: "DELETE" });
  await loadNotes();
  current = notes.find((note) => note.id === current.id);
  fillEditor();
});

$$("[data-open-panel]").forEach((button) =>
  button.addEventListener("click", () => openPanel(button.dataset.openPanel)),
);
$("#closeModalBtn").addEventListener("click", closePanel);
$("#modal").addEventListener("click", (event) => {
  if (event.target === $("#modal")) closePanel();
});
$("#saveLabelsBtn").addEventListener("click", async () => {
  const labelIds = $$("#labelChecks input:checked").map((input) => Number(input.value));
  await api(`/api/notes/${current.id}/labels`, {
    method: "POST",
    body: JSON.stringify({ labelIds }),
  });
  closePanel();
  await loadNotes();
  current = notes.find((note) => note.id === current.id);
  fillEditor();
});
$("#profileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/profile", { method: "PUT", body: new FormData(event.currentTarget) });
    closePanel();
    await checkMe();
    showToast("Profile saved.");
  } catch (error) {
    $("#modalMsg").textContent = error.message;
  }
});
$("#profileForm").avatar.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) $("#profileAvatarPreview").src = URL.createObjectURL(file);
});
$("#prefsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/preferences", {
      method: "PUT",
      body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
    });
    me.preferences = data.preferences;
    cacheAccount();
    document.body.classList.toggle("dark", me.preferences.theme === "dark");
    document.body.style.fontSize = `${me.preferences.fontSize}px`;
    closePanel();
    showToast("Preferences saved.");
  } catch (error) {
    $("#modalMsg").textContent = error.message;
  }
});
$("#changePwForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/password/change", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
    });
    event.currentTarget.reset();
    closePanel();
    showToast("Password changed. Other sessions were revoked.");
  } catch (error) {
    $("#modalMsg").textContent = error.message;
  }
});
$("#imageForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api(`/api/notes/${current.id}/images`, {
      method: "POST",
      body: new FormData(event.currentTarget),
    });
    event.currentTarget.reset();
    closePanel();
    await loadNotes();
    current = notes.find((note) => note.id === current.id);
    fillEditor();
  } catch (error) {
    $("#modalMsg").textContent = error.message;
  }
});
$("#lockForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    data.action = "set";
    await api(`/api/notes/${current.id}/password`, { method: "POST", body: JSON.stringify(data) });
    closePanel();
    await loadNotes();
    current = notes.find((note) => note.id === current.id);
    fillEditor();
  } catch (error) {
    $("#modalMsg").textContent = error.message;
  }
});
$("#lockDisableForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    data.action = "disable";
    await api(`/api/notes/${current.id}/password`, { method: "POST", body: JSON.stringify(data) });
    closePanel();
    await loadNotes();
    current = notes.find((note) => note.id === current.id);
    fillEditor();
  } catch (error) {
    $("#modalMsg").textContent = error.message;
  }
});
$("#shareForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api(`/api/notes/${current.id}/share`, {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
    });
    showToast(data.missing.length ? `Shared, except: ${data.missing.join(", ")}` : "Note shared.");
    await loadNotes();
    current = notes.find((note) => note.id === current.id);
    fillEditor();
  } catch (error) {
    $("#modalMsg").textContent = error.message;
  }
});
$("#importForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const file = form.file.files?.[0];
  if (!file) return;
  try {
    const result = await api("/api/import", {
      method: "POST",
      body: JSON.stringify({
        format: file.name.toLowerCase().endsWith(".md") ? "markdown" : "json",
        data: await file.text(),
        duplicateStrategy: form.duplicateStrategy.value,
      }),
    });
    closePanel();
    await loadNotes();
    showToast(
      `Imported: ${result.created} created, ${result.replaced} replaced, ${result.skipped} skipped.`,
    );
  } catch (error) {
    $("#modalMsg").textContent = error.message;
  }
});
$("#exportJsonBtn").addEventListener("click", () => downloadExport("json"));
$("#exportMarkdownBtn").addEventListener("click", () => downloadExport("markdown"));

boot();
