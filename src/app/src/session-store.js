const session = require("express-session");

class SQLiteSessionStore extends session.Store {
  constructor(db, ttlMs) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare("SELECT sess,expired_at FROM sessions WHERE sid=?").get(sid);
      if (!row || row.expired_at <= Date.now()) {
        if (row) this.db.prepare("DELETE FROM sessions WHERE sid=?").run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, value, callback = () => {}) {
    try {
      const cookieExpiry = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : 0;
      const expiredAt = cookieExpiry || Date.now() + this.ttlMs;
      this.db
        .prepare(
          `INSERT INTO sessions(sid,sess,expired_at) VALUES(?,?,?)
           ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess,expired_at=excluded.expired_at`,
        )
        .run(sid, JSON.stringify(value), expiredAt);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.db.prepare("DELETE FROM sessions WHERE sid=?").run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, value, callback = () => {}) {
    this.set(sid, value, callback);
  }
}

module.exports = { SQLiteSessionStore };
