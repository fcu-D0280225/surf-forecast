/**
 * auth.js — 帳號 / Session 管理
 * 使用 Node.js 內建 crypto（pbkdf2），不需額外套件
 */
import crypto from 'crypto';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, '..', 'data', 'surf-rag.sqlite');

const SESSION_DAYS = 30;

// ── DB 初始化 ─────────────────────────────────────────────────────────────────

let _db = null;
function db() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        username     TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,   -- "salt:hash"
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token        TEXT PRIMARY KEY,
        user_id      INTEGER NOT NULL,
        username     TEXT NOT NULL,
        display_name TEXT NOT NULL,
        expires_at   TEXT NOT NULL
      );
    `);
  }
  return _db;
}

// ── 密碼工具 ──────────────────────────────────────────────────────────────────

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 120_000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = crypto.pbkdf2Sync(password, salt, 120_000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
}

// ── 使用者 CRUD ───────────────────────────────────────────────────────────────

export function createUser(username, password, displayName) {
  db().prepare(`
    INSERT INTO users (username, display_name, password_hash)
    VALUES (?, ?, ?)
  `).run(username.trim().toLowerCase(), displayName.trim(), hashPassword(password));
}

export function listUsers() {
  return db().prepare('SELECT id, username, display_name, created_at FROM users').all();
}

export function deleteUser(username) {
  const u = db().prepare('SELECT id FROM users WHERE username = ?').get(username.toLowerCase());
  if (!u) return false;
  db().prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  db().prepare('DELETE FROM users WHERE id = ?').run(u.id);
  return true;
}

export function userCount() {
  return db().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

// ── Session ───────────────────────────────────────────────────────────────────

export function login(username, password) {
  const user = db().prepare('SELECT * FROM users WHERE username = ?')
                   .get(username.trim().toLowerCase());
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;

  const token    = crypto.randomBytes(32).toString('hex');
  const expires  = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  db().prepare(`
    INSERT INTO sessions (token, user_id, username, display_name, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, user.id, user.username, user.display_name, expires);

  return { token, username: user.username, displayName: user.display_name };
}

export function getSession(token) {
  if (!token) return null;
  const s = db().prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) {
    db().prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return s;
}

export function logout(token) {
  db().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// 定期清理過期 session（每次啟動執行一次）
export function cleanExpiredSessions() {
  db().prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}
