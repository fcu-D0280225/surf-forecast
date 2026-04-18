#!/usr/bin/env node
/**
 * migrate-sqlite-to-mysql.js — 一次性將舊 SQLite 資料匯入 MySQL
 *
 * 來源：
 *   data/surf-rag.sqlite  → users / sessions / surf_log
 *   data/feedback.sqlite  → reports
 *
 * 使用方法：node scripts/migrate-sqlite-to-mysql.js [--truncate]
 *   --truncate  匯入前清空目標表（重跑用）
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { initDb, run, pool } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAG_SQLITE      = path.join(__dirname, '..', 'data', 'surf-rag.sqlite');
const FEEDBACK_SQLITE = path.join(__dirname, '..', 'data', 'feedback.sqlite');
const TRUNCATE        = process.argv.includes('--truncate');

function tableHasColumn(db, table, column) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some(c => c.name === column);
  } catch {
    return false;
  }
}

function tableExists(db, table) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  return !!row;
}

async function migrateUsers(db) {
  if (!tableExists(db, 'users')) { console.log('  users：SQLite 無此表，略過'); return 0; }
  const hasAdmin  = tableHasColumn(db, 'users', 'is_admin');
  const hasPoints = tableHasColumn(db, 'users', 'points');
  const rows = db.prepare(`
    SELECT id, username, display_name, password_hash,
           ${hasAdmin  ? 'is_admin' : '0 AS is_admin'},
           ${hasPoints ? 'points'   : '0 AS points'},
           created_at
    FROM users
  `).all();
  for (const r of rows) {
    await run(
      `INSERT INTO users (id, username, display_name, password_hash, is_admin, points, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.username, r.display_name, r.password_hash, r.is_admin ?? 0, r.points ?? 0, r.created_at],
    );
  }
  return rows.length;
}

async function migrateSessions(db) {
  if (!tableExists(db, 'sessions')) { console.log('  sessions：SQLite 無此表，略過'); return 0; }
  const rows = db.prepare(`SELECT token, user_id, username, display_name, expires_at FROM sessions`).all();
  for (const r of rows) {
    await run(
      `INSERT INTO sessions (token, user_id, username, display_name, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [r.token, r.user_id, r.username, r.display_name, r.expires_at],
    );
  }
  return rows.length;
}

async function migrateSurfLog(db) {
  if (!tableExists(db, 'surf_log')) { console.log('  surf_log：SQLite 無此表，略過'); return 0; }
  const cols = db.prepare(`PRAGMA table_info(surf_log)`).all().map(c => c.name);
  const colList = cols.join(', ');
  const rows = db.prepare(`SELECT ${colList} FROM surf_log ORDER BY id`).all();

  for (const r of rows) {
    await run(
      `INSERT INTO surf_log
        (id, date_iso, spot, rating, notes, content, embedding, created_at,
         wave_height_m, wave_period_s, wind_speed_kmh,
         wind_direction_deg, wind_direction_text, swell_height_m, swell_period_s,
         wave_direction_deg, wave_direction_text, water_temp_c, weather_text, tide)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.id,
        r.date_iso,
        r.spot,
        r.rating,
        r.notes ?? null,
        r.content,
        r.embedding, // Buffer from SQLite BLOB → LONGBLOB
        r.created_at,
        r.wave_height_m        ?? null,
        r.wave_period_s        ?? null,
        r.wind_speed_kmh       ?? null,
        r.wind_direction_deg   ?? null,
        r.wind_direction_text  ?? null,
        r.swell_height_m       ?? null,
        r.swell_period_s       ?? null,
        r.wave_direction_deg   ?? null,
        r.wave_direction_text  ?? null,
        r.water_temp_c         ?? null,
        r.weather_text         ?? null,
        r.tide                 ?? null,
      ],
    );
  }
  return rows.length;
}

async function migrateReports(db) {
  if (!tableExists(db, 'reports')) { console.log('  reports：SQLite 無此表，略過'); return 0; }
  const rows = db.prepare(`SELECT id, content, created_at FROM reports ORDER BY id`).all();
  for (const r of rows) {
    await run(
      `INSERT INTO reports (id, content, created_at) VALUES (?, ?, ?)`,
      [r.id, r.content, r.created_at],
    );
  }
  return rows.length;
}

async function main() {
  await initDb();

  if (TRUNCATE) {
    console.log('🧹 清空 MySQL 目標表…');
    await run('DELETE FROM sessions');
    await run('DELETE FROM surf_log');
    await run('ALTER TABLE surf_log AUTO_INCREMENT = 1');
    await run('DELETE FROM reports');
    await run('ALTER TABLE reports AUTO_INCREMENT = 1');
    await run('DELETE FROM users');
    await run('ALTER TABLE users AUTO_INCREMENT = 1');
  }

  console.log('\n📦 從 surf-rag.sqlite 匯入…');
  if (existsSync(RAG_SQLITE)) {
    const ragDb = new Database(RAG_SQLITE, { readonly: true });
    const u = await migrateUsers(ragDb);
    console.log(`  users：${u} 筆`);
    const s = await migrateSessions(ragDb);
    console.log(`  sessions：${s} 筆`);
    const l = await migrateSurfLog(ragDb);
    console.log(`  surf_log：${l} 筆`);
    ragDb.close();
  } else {
    console.log('  (檔案不存在，略過)');
  }

  console.log('\n📦 從 feedback.sqlite 匯入…');
  if (existsSync(FEEDBACK_SQLITE)) {
    const fbDb = new Database(FEEDBACK_SQLITE, { readonly: true });
    const r = await migrateReports(fbDb);
    console.log(`  reports：${r} 筆`);
    fbDb.close();
  } else {
    console.log('  (檔案不存在，略過)');
  }

  console.log('\n✅ 匯入完成');
  await pool.end();
}

main().catch(async (e) => {
  console.error('❌ 匯入失敗：', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
