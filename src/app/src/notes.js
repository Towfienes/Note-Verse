function accessNote(db, userId, noteId, { includeDeleted = false } = {}) {
  const deletedClause = includeDeleted ? "" : "AND n.deleted_at IS NULL";
  const row = db
    .prepare(
      `SELECT n.*, CASE WHEN n.user_id=? THEN 'owner' ELSE 'shared' END role,
       CASE WHEN n.user_id=? THEN 'edit' ELSE s.permission END permission,
       s.id share_id
       FROM notes n
       LEFT JOIN shares s ON s.note_id=n.id AND s.recipient_id=?
       WHERE n.id=? ${deletedClause} AND (n.user_id=? OR s.id IS NOT NULL)`,
    )
    .get(userId, userId, userId, noteId, userId);
  return row || null;
}

function isUnlocked(session, note) {
  return !note.password_hash || session?.unlockedNotes?.[note.id] === note.lock_version;
}

function hydrateNote(db, row, viewerId, session) {
  const unlocked = isUnlocked(session, row);
  const labels = unlocked
    ? db
        .prepare(
          "SELECT l.id,l.name FROM labels l JOIN note_labels nl ON nl.label_id=l.id WHERE nl.note_id=? ORDER BY l.name",
        )
        .all(row.id)
    : [];
  const images = unlocked
    ? db
        .prepare("SELECT id,original_name FROM note_images WHERE note_id=? ORDER BY id DESC")
        .all(row.id)
        .map((image) => ({ ...image, url: `/api/images/${image.id}` }))
    : [];
  const shares =
    row.user_id === viewerId && unlocked
      ? db
          .prepare(
            `SELECT s.id,s.permission,s.created_at,u.email,u.display_name
             FROM shares s JOIN users u ON u.id=s.recipient_id
             WHERE s.note_id=? ORDER BY s.created_at DESC`,
          )
          .all(row.id)
      : [];
  const incoming =
    row.user_id === viewerId
      ? null
      : db
          .prepare(
            `SELECT s.permission,s.created_at,u.email owner_email,u.display_name owner_name
             FROM shares s JOIN users u ON u.id=s.owner_id
             WHERE s.note_id=? AND s.recipient_id=?`,
          )
          .get(row.id, viewerId);

  return {
    id: row.id,
    user_id: row.user_id,
    title: unlocked ? row.title : "Protected note",
    content: unlocked ? row.content : "",
    color: row.color,
    is_pinned: Boolean(row.is_pinned),
    is_locked: Boolean(row.password_hash),
    is_unlocked: unlocked,
    role: row.role || (row.user_id === viewerId ? "owner" : "shared"),
    permission: row.permission || (row.user_id === viewerId ? "edit" : "read"),
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    labels,
    images,
    shares,
    incoming,
  };
}

function conflictResponse(db, res, access, userId, session) {
  const latest = accessNote(db, userId, access.id || access.note?.id || access, {
    includeDeleted: true,
  });
  return res.status(409).json({
    error: "This note changed elsewhere. Review both versions before saving.",
    code: "VERSION_CONFLICT",
    current: latest ? hydrateNote(db, latest, userId, session) : null,
  });
}

module.exports = { accessNote, conflictResponse, hydrateNote, isUnlocked };
