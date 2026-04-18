/**
 * auth.js — 帳號 / Session 管理（MySQL 版）
 * 使用 Node.js 內建 crypto（pbkdf2）處理密碼雜湊
 */
import crypto from 'crypto';
import { run, first, all, pool, initDb } from './db.js';

const SESSION_DAYS = 30;

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

export async function createUser(username, password, displayName, { isAdmin = false, points = 0 } = {}) {
  await run(
    `INSERT INTO users (username, display_name, password_hash, is_admin, points)
     VALUES (?, ?, ?, ?, ?)`,
    [username.trim().toLowerCase(), displayName.trim(), hashPassword(password), isAdmin ? 1 : 0, points],
  );
}

export async function listUsers() {
  return all(
    `SELECT id, username, display_name, is_admin, points, created_at
     FROM users ORDER BY id`,
  );
}

export async function setPoints(username, points) {
  const r = await run(
    `UPDATE users SET points = ? WHERE username = ?`,
    [points, username.trim().toLowerCase()],
  );
  return r.affectedRows > 0;
}

// Returns { success, points } — fails if user has no points
export async function deductPoint(userId) {
  await initDb();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT points, is_admin FROM users WHERE id = ? FOR UPDATE`,
      [userId],
    );
    const user = rows[0];
    if (!user) {
      await conn.rollback();
      return { success: false, points: 0 };
    }
    if (user.is_admin) {
      await conn.commit();
      return { success: true, points: null };
    }
    if (user.points <= 0) {
      await conn.rollback();
      return { success: false, points: 0 };
    }
    await conn.execute(
      `UPDATE users SET points = points - 1 WHERE id = ?`,
      [userId],
    );
    await conn.commit();
    return { success: true, points: user.points - 1 };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

export async function getUserInfo(userId) {
  return first(
    `SELECT id, username, display_name, is_admin, points FROM users WHERE id = ?`,
    [userId],
  );
}

export async function deleteUser(username) {
  const u = await first(
    `SELECT id FROM users WHERE username = ?`,
    [username.toLowerCase()],
  );
  if (!u) return false;
  await run(`DELETE FROM sessions WHERE user_id = ?`, [u.id]);
  await run(`DELETE FROM users WHERE id = ?`, [u.id]);
  return true;
}

export async function userCount() {
  const row = await first(`SELECT COUNT(*) AS n FROM users`);
  return row?.n ?? 0;
}

// ── Session ───────────────────────────────────────────────────────────────────

export async function login(username, password) {
  const user = await first(
    `SELECT * FROM users WHERE username = ?`,
    [username.trim().toLowerCase()],
  );
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;

  const token   = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000)
    .toISOString().slice(0, 19).replace('T', ' ');

  await run(
    `INSERT INTO sessions (token, user_id, username, display_name, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [token, user.id, user.username, user.display_name, expires],
  );

  return { token, username: user.username, displayName: user.display_name, isAdmin: !!user.is_admin };
}

export async function getSession(token) {
  if (!token) return null;
  const s = await first(
    `SELECT * FROM sessions WHERE token = ?`,
    [token],
  );
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) {
    await run(`DELETE FROM sessions WHERE token = ?`, [token]);
    return null;
  }
  return s;
}

export async function logout(token) {
  await run(`DELETE FROM sessions WHERE token = ?`, [token]);
}

/** 定期清理過期 session（啟動時執行一次） */
export async function cleanExpiredSessions() {
  await run(`DELETE FROM sessions WHERE expires_at < NOW()`);
}
