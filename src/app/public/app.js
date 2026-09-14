let me = null;
let notes = [];
let labels = [];
let current = null;
let view = localStorage.view || "grid";
let scope = localStorage.noteScope || "all";
let saveTimer = null;
let searchTimer = null;
let stateTimer = null;
let refreshTimer = null;
let socket = null;

const OFFLINE_EDITS_KEY = "noteverseOfflineEdits";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(url, opt = {}) {
  const headers =
    opt.body instanceof FormData ? {} : { "Content-Type": "application/json" };
  const response = await fetch(url, { headers, ...opt });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: response.statusText }));
    throw new Error(error.error || "Request failed");
  }
  return response.json().catch(() => ({ ok: true }));
}

function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function tab(name) {
  $$(".auth-form").forEach((form) => form.classList.add("hidden"));
  $(`#${name}Form`).classList.remove("hidden");
  $("#authMsg").textContent = "";
}

function toast(message) {
  $("#modalMsg").textContent = message;
  setTimeout(() => {
    $("#modalMsg").textContent = "";
  }, 3500);
}

function getQueuedEdits() {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_EDITS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveQueuedEdits(queue) {
  localStorage.setItem(OFFLINE_EDITS_KEY, JSON.stringify(queue));
  updateSyncState();
}

function queuedEditCount() {
  return Object.keys(getQueuedEdits()).length;
}

function updateSyncState(message = "") {
  const count = queuedEditCount();
  const syncState = $("#syncState");
  if (syncState) {
    syncState.textContent =
      message ||
      (count
        ? `${count} offline edit${count === 1 ? "" : "s"} waiting to sync`
        : "");
  }
  const offline = $("#offline");
  if (offline) {
    offline.classList.toggle("hidden", navigator.onLine && count === 0);
  }
}

function networkLooksOffline(error) {
  return (
    !navigator.onLine ||
    /Failed to fetch|NetworkError|Load failed/i.test(error.message || "")
  );
}

function cacheNotes() {
  try {
    localStorage.cachedNotes = JSON.stringify(notes);
  } catch {}
}

function applyQueuedEdits(list) {
  const queued = getQueuedEdits();
  return list.map((note) =>
    queued[note.id]
      ? { ...note, ...queued[note.id], offlineQueued: true }
      : note,
  );
}

function patchNote(id, patch) {
  notes = notes.map((note) => (note.id === id ? { ...note, ...patch } : note));
  if (current?.id === id) current = { ...current, ...patch };
  cacheNotes();
}

function queueOfflineEdit(noteId, body) {
  const queue = getQueuedEdits();
  queue[noteId] = { id: noteId, ...body, queuedAt: new Date().toISOString() };
  saveQueuedEdits(queue);
  patchNote(noteId, { ...body, offlineQueued: true });
}

async function syncOfflineEdits() {
  if (!navigator.onLine || !me) {
    updateSyncState();
    return;
  }

  const entries = Object.values(getQueuedEdits());
  if (!entries.length) {
    updateSyncState("");
    return;
  }

  updateSyncState(
    `Syncing ${entries.length} offline edit${entries.length === 1 ? "" : "s"}...`,
  );
  for (const edit of entries) {
    try {
      await api(`/api/notes/${edit.id}`, {
        method: "PUT",
        body: JSON.stringify({
          title: edit.title,
          content: edit.content,
        }),
      });
      const queue = getQueuedEdits();
      delete queue[edit.id];
      saveQueuedEdits(queue);
      patchNote(edit.id, {
        title: edit.title,
        content: edit.content,
        offlineQueued: false,
      });
      renderNotes();
    } catch (error) {
      if (networkLooksOffline(error)) break;
      const queue = getQueuedEdits();
      delete queue[edit.id];
      saveQueuedEdits(queue);
      toast(
        `Offline edit for note #${edit.id} was not synced: ${error.message}`,
      );
    }
  }

  if (queuedEditCount() === 0) {
    updateSyncState("All offline edits synced");
    if (
      current?.permission === "edit" &&
      socket?.readyState !== WebSocket.OPEN
    ) {
      connectRealtime();
    }
    setTimeout(() => updateSyncState(""), 2000);
  } else {
    updateSyncState();
  }
}

async function boot() {
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("/service-worker.js");
  window.addEventListener("online", async () => {
    await syncOfflineEdits();
    await loadNotes();
  });
  window.addEventListener("offline", () => updateSyncState());
  await checkMe();
  updateSyncState();
}

async function checkMe() {
  try {
    const data = await api("/api/me");
    me = data.user;
    $("#auth").classList.add("hidden");
    $("#app").classList.remove("hidden");
    $("#userEmail").textContent = me.email;
    $("#userAvatar").src = me.avatar_path || "/icon.svg";
    $("#unverified").classList.toggle("hidden", !!me.is_active);
    document.body.classList.toggle("dark", me.preferences?.theme === "dark");
    document.body.style.fontSize = `${me.preferences?.fontSize || 16}px`;
    renderNotifications(data.notifications || []);
    await loadLabels();
    await syncOfflineEdits();
    await loadNotes();
    startLiveRefresh();
  } catch {
    $("#auth").classList.remove("hidden");
    $("#app").classList.add("hidden");
  }
}

function startLiveRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (me && navigator.onLine && !document.hidden) loadNotes();
  }, 5000);
}

function renderNotifications(items) {
  const container = $("#notifications");
  const newItems = (items || []).filter((item) => !item.is_read);
  if (!newItems.length) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = newItems
    .map(
      (item) =>
        `<div class="notification">${esc(item.message)} <small>${esc(item.created_at)}</small></div>`,
    )
    .join("");

  // Auto-hide notifications after a short delay and mark them read on the server
  setTimeout(() => {
    container.innerHTML = "";
  }, 3500);
  (async () => {
    try {
      await api("/api/notifications/mark-read", { method: "POST" });
    } catch (e) {}
  })();
}

async function loadLabels() {
  labels = await api("/api/labels");
  renderLabels();
}

function renderLabels() {
  const activeLabel = new URLSearchParams(location.search).get("label") || "";
  $("#labels").innerHTML =
    `
    <div class="label-row single">
      <button class="label-filter ${activeLabel ? "" : "active"}" onclick="filterLabel('')">All labels</button>
    </div>
  ` +
    labels
      .map(
        (label) => `
    <div class="label-row">
      <button class="label-filter ${String(label.id) === activeLabel ? "active" : ""}" title="${esc(label.name)}" onclick="filterLabel(${label.id})">${esc(label.name)}</button>
      <span class="label-actions">
        <button title="Rename label" onclick="renameLabel(${label.id})">Rename</button>
        <button title="Delete label" onclick="deleteLabel(${label.id})">Delete</button>
      </span>
    </div>
  `,
      )
      .join("");
  if (current) renderLabelChecks();
}

function filterLabel(id) {
  const params = new URLSearchParams(location.search);
  if (id) params.set("label", id);
  else params.delete("label");
  history.replaceState(
    null,
    "",
    params.toString() ? `?${params}` : location.pathname,
  );
  loadNotes();
}

function setNoteScope(nextScope) {
  scope = nextScope;
  localStorage.noteScope = nextScope;
  renderNotes();
}

function renderScopeControls() {
  const titles = {
    all: "All notes",
    mine: "My notes",
    shared: "Shared with me",
  };
  $("#scopeTitle").textContent = titles[scope] || titles.all;
  [
    ["#allNotesBtn", "all"],
    ["#myNotesBtn", "mine"],
    ["#sharedNotesBtn", "shared"],
  ].forEach(([selector, value]) => {
    const button = $(selector);
    if (button) button.classList.toggle("active", scope === value);
  });
}

async function loadNotes() {
  try {
    if (!navigator.onLine && localStorage.cachedNotes) {
      notes = applyQueuedEdits(JSON.parse(localStorage.cachedNotes));
      refreshCurrentFromNotes();
      renderNotes();
      return;
    }

    const params = new URLSearchParams();
    const search = $("#search").value.trim();
    const label = new URLSearchParams(location.search).get("label");
    if (search) params.set("search", search);
    if (label) params.set("label", label);
    notes = applyQueuedEdits(await api(`/api/notes?${params}`));
    cacheNotes();
    refreshCurrentFromNotes();
    renderNotes();
  } catch (error) {
    if (localStorage.cachedNotes) {
      notes = applyQueuedEdits(JSON.parse(localStorage.cachedNotes));
      refreshCurrentFromNotes();
      renderNotes();
      updateSyncState();
    }
  }
}

function refreshCurrentFromNotes() {
  if (!current) return;
  const refreshed = notes.find((note) => note.id === current.id);
  if (!refreshed) return;
  const active = document.activeElement;
  const isTyping = active === $("#noteTitle") || active === $("#noteContent");
  if (canEditCurrent() && isTyping) return;
  current = { ...current, ...refreshed };
  $("#noteTitle").value = current.title || "";
  $("#noteContent").value = current.content || "";
  $("#noteIcons").textContent = noteIcons(current);
  renderImages();
  renderShareInfo();
  renderLabelChecks();
  applyEditorPermissions();
}

function visibleNotes() {
  if (scope === "mine") return notes.filter((note) => note.role !== "shared");
  if (scope === "shared") return notes.filter((note) => note.role === "shared");
  return notes;
}

function noteIcons(note) {
  return `${note.is_pinned ? "📌" : ""}${note.is_locked ? "🔒" : ""}${note.shares?.length || note.incoming ? "🤝" : ""}${note.offlineQueued ? "⏳" : ""}`;
}

function renderNotes() {
  renderScopeControls();
  const box = $("#notes");
  const list = visibleNotes();
  box.className = `notes ${view}`;
  box.innerHTML =
    list
      .map(
        (note) => `
    <article class="note-card ${note.role === "shared" ? "shared-card" : ""}" style="background:${note.color || "#fff"}" onclick="openNote(${note.id})">
      <div class="icons">${noteIcons(note)}</div>
      <h3>${esc(note.title || "Untitled")}</h3>
      <p>${note.is_locked && !note.content ? "This note is locked. Click to unlock." : esc(note.content || "")}</p>
      <div class="chips">
        ${(note.labels || []).map((label) => `<span class="chip">${esc(label.name)}</span>`).join("")}
        ${note.role === "shared" ? `<span class="chip">Shared ${permissionLabel(note.permission)}</span>` : ""}
        ${note.incoming ? `<span class="chip">From ${esc(note.incoming.owner_email)}</span>` : ""}
        ${note.offlineQueued ? '<span class="chip warning">Queued offline</span>' : ""}
      </div>
    </article>
  `,
      )
      .join("") ||
    `<p class="muted">No notes in ${esc($("#scopeTitle").textContent.toLowerCase())}.</p>`;
}

async function openNote(id) {
  current = notes.find((note) => note.id === id);
  if (!current) return;

  if (current.is_locked && !current.content) {
    const password = prompt(
      "This note is password-protected. Enter password to unlock:",
    );
    if (!password) return;
    try {
      await api(`/api/notes/${id}/unlock`, {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      await loadNotes();
      current = notes.find((note) => note.id === id);
    } catch (error) {
      alert(error.message);
      return;
    }
  }

  $("#editor").classList.remove("hidden");
  $("#noteTitle").value = current.title || "";
  $("#noteContent").value = current.content || "";
  $("#noteIcons").textContent = noteIcons(current);
  renderImages();
  renderShareInfo();
  renderLabelChecks();
  applyEditorPermissions();
  connectRealtime();
}

function closeEditor() {
  if (socket) socket.close();
  socket = null;
  current = null;
  $("#editor").classList.add("hidden");
}

function canEditCurrent() {
  return current?.permission === "edit";
}

function isOwnerCurrent() {
  return current && current.role !== "shared";
}

function applyEditorPermissions() {
  const canEdit = canEditCurrent();
  const isOwner = isOwnerCurrent();
  $("#noteTitle").disabled = !canEdit;
  $("#noteContent").disabled = !canEdit;
  $("#readOnlyNotice").classList.toggle("hidden", canEdit);
  $("#imageBtn").classList.toggle("hidden", !canEdit);
  ["#pinBtn", "#deleteBtn", "#noteLabelsBtn", "#lockBtn", "#shareBtn"].forEach(
    (selector) => {
      $(selector).classList.toggle("hidden", !isOwner);
    },
  );
  $("#saveState").textContent = canEdit
    ? current.offlineQueued
      ? "Queued offline"
      : "Ready"
    : "Read only";
}

function renderImages() {
  const deleteControl = (image) =>
    canEditCurrent()
      ? `<button class="image-delete" title="Delete image" onclick="deleteImage(${image.id})">Remove</button>`
      : "";
  $("#imageList").innerHTML = (current.images || [])
    .map(
      (image) => `
      <figure class="image-thumb">
        <img src="${esc(image.path)}" alt="${esc(image.original_name || "attachment")}">
        ${deleteControl(image)}
      </figure>
    `,
    )
    .join("");
}

async function deleteImage(imageId) {
  if (!current || !canEditCurrent())
    return toast("Read-only shared notes cannot be edited.");
  if (!confirm("Delete this image attachment?")) return;
  const noteId = current.id;
  try {
    await api(`/api/notes/${noteId}/images/${imageId}`, { method: "DELETE" });
    current.images = (current.images || []).filter(
      (image) => image.id !== imageId,
    );
    renderImages();
    await loadNotes();
    current = notes.find((note) => note.id === noteId) || current;
    renderImages();
  } catch (error) {
    toast(error.message);
  }
}

function permissionLabel(permission) {
  return permission === "edit" ? "editable" : "read-only";
}

function renderShareInfo() {
  if (!current) return;
  let incoming = "";
  if (current.incoming) {
    incoming = `
      <div class="share-detail">
        Shared by <b>${esc(current.incoming.owner_name)}</b>
        (${esc(current.incoming.owner_email)}) as
        <b>${permissionLabel(current.incoming.permission)}</b>
        at ${esc(current.incoming.created_at)}
      </div>
    `;
  }

  let recipients = "";
  if (current.shares?.length && isOwnerCurrent()) {
    recipients = `
      <b>Recipients</b>
      <div class="share-recipients">
        ${current.shares
          .map(
            (share) => `
          <div class="share-recipient">
            <span>${esc(share.email)}</span>
            <select onchange="updateSharePermission(${share.id}, this.value)">
              <option value="read" ${share.permission === "read" ? "selected" : ""}>Read only</option>
              <option value="edit" ${share.permission === "edit" ? "selected" : ""}>Editable</option>
            </select>
            <small>${esc(share.created_at)}</small>
            <button onclick="revokeShare(${share.id})">Revoke</button>
          </div>
        `,
          )
          .join("")}
      </div>
    `;
  }

  const html =
    incoming + recipients ||
    '<span class="muted">This note is not shared.</span>';
  $("#shareList").innerHTML = html;
  $("#ownerShares").innerHTML = isOwnerCurrent()
    ? recipients || '<span class="muted">No recipients yet.</span>'
    : incoming || '<span class="muted">No sharing details.</span>';
}

async function saveNote() {
  if (!current || !canEditCurrent()) {
    $("#saveState").textContent = "Read only";
    return;
  }

  const body = {
    title: $("#noteTitle").value,
    content: $("#noteContent").value,
  };

  clearTimeout(stateTimer);
  $("#saveState").textContent = navigator.onLine
    ? "Saving..."
    : "Queued offline";
  patchNote(current.id, body);

  if (!navigator.onLine) {
    queueOfflineEdit(current.id, body);
    renderNotes();
    return;
  }

  try {
    await api(`/api/notes/${current.id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const queue = getQueuedEdits();
    delete queue[current.id];
    saveQueuedEdits(queue);
    patchNote(current.id, { ...body, offlineQueued: false });
    $("#saveState").textContent = "Saved";
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: "edit", ...body }));
    renderNotes();
  } catch (error) {
    if (networkLooksOffline(error)) {
      queueOfflineEdit(current.id, body);
      $("#saveState").textContent = "Queued offline";
      renderNotes();
    } else {
      $("#saveState").textContent = error.message;
    }
  }

  stateTimer = setTimeout(() => {
    if (current)
      $("#saveState").textContent = current.offlineQueued
        ? "Queued offline"
        : "Ready";
  }, 1500);
}

function debounceSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNote, 300);
}

function connectRealtime() {
  if (socket) socket.close();
  if (!current || current.permission !== "edit") return;
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?noteId=${current.id}`,
  );
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (
      (message.type === "remoteEdit" || message.type === "saved") &&
      current?.id
    ) {
      if (message.from === me?.id) return;
      $("#noteTitle").value = message.title;
      $("#noteContent").value = message.content;
      patchNote(current.id, { title: message.title, content: message.content });
      renderNotes();
      $("#saveState").textContent = "Remote changes received";
    }
  };
}

function openPanel(id) {
  if (
    current &&
    ["noteLabelPanel", "lockPanel", "sharePanel"].includes(id) &&
    !isOwnerCurrent()
  ) {
    toast("Only the note owner can use this action.");
    return;
  }
  if (current && id === "imagePanel" && !canEditCurrent()) {
    toast("Read-only shared notes cannot be edited.");
    return;
  }

  $$(".panel").forEach((panel) => panel.classList.add("hidden"));
  $(`#${id}`).classList.remove("hidden");
  $("#modal").classList.remove("hidden");
  $("#modalMsg").textContent = "";

  if (id === "profilePanel" && me) {
    $("#profileForm").displayName.value = me.display_name;
    $("#profileAvatarPreview").src = me.avatar_path || "/icon.svg";
  }
  if (id === "prefsPanel" && me) {
    $("#prefsForm").fontSize.value = me.preferences?.fontSize || 16;
    $("#prefsForm").theme.value = me.preferences?.theme || "light";
    $("#prefsForm").defaultColor.value =
      me.preferences?.defaultColor || "#ffffff";
  }
  if (id === "noteLabelPanel") renderLabelChecks();
  if (id === "lockPanel") configureLockPanel();
  if (id === "sharePanel") renderShareInfo();
}

function closePanel() {
  $("#modal").classList.add("hidden");
}

function renderLabelChecks() {
  if (!current) return;
  const attached = new Set((current.labels || []).map((label) => label.id));
  $("#labelChecks").innerHTML =
    labels
      .map(
        (label) => `
    <label class="check-row" title="${esc(label.name)}">
      <span>${esc(label.name)}</span>
      <input type="checkbox" value="${label.id}" ${attached.has(label.id) ? "checked" : ""}>
    </label>
  `,
      )
      .join("") || "<p>Create a label first.</p>";
}

function configureLockPanel() {
  const protectedNote = !!current?.is_locked;
  $("#lockForm").reset();
  $("#lockDisableForm").reset();
  $("#lockCurrent").classList.toggle("hidden", !protectedNote);
  $("#lockDisableForm").classList.toggle("hidden", !protectedNote);
  $("#lockSetBtn").textContent = protectedNote
    ? "Change password"
    : "Enable password";
  $("#lockHint").textContent = protectedNote
    ? "To change the note password, enter the current password and the new password twice. To disable protection, only enter the current password below."
    : "This note is not password-protected. Enter a new password twice to enable protection.";
}

async function saveNoteLabels() {
  if (!isOwnerCurrent()) return toast("Only the note owner can change labels.");
  const labelIds = $$("#labelChecks input:checked").map((input) =>
    Number(input.value),
  );
  await api(`/api/notes/${current.id}/labels`, {
    method: "POST",
    body: JSON.stringify({ labelIds }),
  });
  closePanel();
  await loadNotes();
  openNote(current.id);
}

async function renameLabel(id) {
  const label = labels.find((item) => item.id === id);
  const name = prompt("New label name:", label?.name || "");
  if (!name) return;
  try {
    await api(`/api/labels/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    });
    await loadLabels();
    await loadNotes();
  } catch (error) {
    alert(error.message);
  }
}

async function deleteLabel(id) {
  if (!confirm("Delete label? Notes will not be deleted.")) return;
  await api(`/api/labels/${id}`, { method: "DELETE" });
  await loadLabels();
  await loadNotes();
}

async function updateSharePermission(id, permission) {
  try {
    await api(`/api/shares/${id}`, {
      method: "PUT",
      body: JSON.stringify({ permission }),
    });
    toast("Sharing permission updated.");
    await loadNotes();
    if (current) openNote(current.id);
  } catch (error) {
    toast(error.message);
  }
}

async function revokeShare(id) {
  if (!confirm("Revoke this share?")) return;
  await api(`/api/shares/${id}`, { method: "DELETE" });
  await loadNotes();
  if (current) openNote(current.id);
}

$("#loginForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData($("#loginForm")))),
    });
    await checkMe();
  } catch (error) {
    $("#authMsg").textContent = error.message;
  }
};

$("#registerForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("/api/register", {
      method: "POST",
      body: JSON.stringify(
        Object.fromEntries(new FormData($("#registerForm"))),
      ),
    });
    await checkMe();
  } catch (error) {
    $("#authMsg").textContent = error.message;
  }
};

$("#forgotForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("/api/password/request-reset", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData($("#forgotForm")))),
    });
    $("#authMsg").textContent = "Check MailHog for reset link / OTP.";
  } catch (error) {
    $("#authMsg").textContent = error.message;
  }
};

$("#logoutBtn").onclick = async () => {
  await api("/api/logout", { method: "POST" });
  location.reload();
};

$("#newNoteBtn").onclick = async () => {
  const note = await api("/api/notes", {
    method: "POST",
    body: JSON.stringify({
      title: "Untitled",
      content: "",
      color: me.preferences?.defaultColor || "#ffffff",
    }),
  });
  scope = "mine";
  localStorage.noteScope = scope;
  $("#search").value = "";
  history.replaceState(null, "", location.pathname);
  await loadNotes();
  openNote(note.id);
};

$("#search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadNotes, 300);
};

$("#gridBtn").onclick = () => {
  view = "grid";
  localStorage.view = view;
  renderNotes();
};

$("#listBtn").onclick = () => {
  view = "list";
  localStorage.view = view;
  renderNotes();
};

$("#allNotesBtn").onclick = () => setNoteScope("all");
$("#myNotesBtn").onclick = () => setNoteScope("mine");
$("#sharedNotesBtn").onclick = () => setNoteScope("shared");

$("#noteTitle").oninput = debounceSave;
$("#noteContent").oninput = debounceSave;

$("#pinBtn").onclick = async () => {
  if (!isOwnerCurrent()) return;
  await api(`/api/notes/${current.id}/pin`, {
    method: "POST",
    body: JSON.stringify({ pin: !current.is_pinned }),
  });
  await loadNotes();
  openNote(current.id);
};

$("#deleteBtn").onclick = async () => {
  if (
    !isOwnerCurrent() ||
    !confirm("Are you sure you want to delete this note?")
  )
    return;
  await api(`/api/notes/${current.id}`, { method: "DELETE" });
  closeEditor();
  await loadNotes();
};

$("#labelForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("/api/labels", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData($("#labelForm")))),
    });
    $("#labelForm").reset();
    await loadLabels();
  } catch (error) {
    alert(error.message);
  }
};

$("#profileForm").onsubmit = async (event) => {
  event.preventDefault();
  await api("/api/profile", {
    method: "PUT",
    body: new FormData($("#profileForm")),
  });
  toast("Profile saved");
  await checkMe();
};

$("#profileForm").elements.avatar.onchange = (event) => {
  const file = event.target.files?.[0];
  if (file) $("#profileAvatarPreview").src = URL.createObjectURL(file);
};

$("#prefsForm").onsubmit = async (event) => {
  event.preventDefault();
  await api("/api/preferences", {
    method: "PUT",
    body: JSON.stringify(Object.fromEntries(new FormData($("#prefsForm")))),
  });
  toast("Preferences saved");
  await checkMe();
};

$("#changePwForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("/api/password/change", {
      method: "POST",
      body: JSON.stringify(
        Object.fromEntries(new FormData($("#changePwForm"))),
      ),
    });
    toast("Password changed");
  } catch (error) {
    toast(error.message);
  }
};

$("#imageForm").onsubmit = async (event) => {
  event.preventDefault();
  if (!canEditCurrent())
    return toast("Read-only shared notes cannot be edited.");
  await api(`/api/notes/${current.id}/images`, {
    method: "POST",
    body: new FormData($("#imageForm")),
  });
  closePanel();
  await loadNotes();
  openNote(current.id);
};

$("#lockForm").onsubmit = async (event) => {
  event.preventDefault();
  if (!isOwnerCurrent())
    return toast("Only the note owner can change note password.");
  const data = Object.fromEntries(new FormData($("#lockForm")));
  data.action = "set";
  try {
    await api(`/api/notes/${current.id}/password`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    closePanel();
    await loadNotes();
    openNote(current.id);
  } catch (error) {
    toast(error.message);
  }
};

$("#lockDisableForm").onsubmit = async (event) => {
  event.preventDefault();
  if (!isOwnerCurrent())
    return toast("Only the note owner can change note password.");
  const data = Object.fromEntries(new FormData($("#lockDisableForm")));
  data.action = "disable";
  try {
    await api(`/api/notes/${current.id}/password`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    closePanel();
    await loadNotes();
    openNote(current.id);
  } catch (error) {
    toast(error.message);
  }
};

$("#shareForm").onsubmit = async (event) => {
  event.preventDefault();
  if (!isOwnerCurrent())
    return toast("Only the note owner can share this note.");
  try {
    const data = await api(`/api/notes/${current.id}/share`, {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData($("#shareForm")))),
    });
    toast(
      data.missing?.length
        ? `Shared, but missing registered users: ${data.missing.join(", ")}`
        : "Note shared and email notification sent",
    );
    await loadNotes();
    openNote(current.id);
  } catch (error) {
    toast(error.message);
  }
};

boot();
