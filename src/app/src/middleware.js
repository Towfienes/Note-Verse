function createRequireAuth(db) {
  return (req, res, next) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Please log in first." });
    const user = db
      .prepare(
        "SELECT id,email,display_name,avatar_path,is_active,preferences,session_version FROM users WHERE id=?",
      )
      .get(req.session.userId);
    if (!user?.is_active || user.session_version !== req.session.sessionVersion) {
      return req.session.destroy(() =>
        res.status(401).json({ error: "Your session is no longer valid." }),
      );
    }
    req.user = user;
    next();
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { asyncRoute, createRequireAuth };
