/**
 * rag-db.js — 用戶浪況回饋 RAG 儲存
 * 自由文字，不強制綁定浪點或日期格式，原文存入，Claude 自行解讀。
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, '..', 'data', 'feedback.sqlite');

mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

/** 新增一筆自由文字回饋 */
export function insertReport(content) {
  db.prepare(`INSERT INTO reports (content) VALUES (?)`).run(content.trim());
}

/** 取最近 N 筆回饋（供 Claude prompt 使用） */
export function getRecentReports(limit = 15) {
  return db.prepare(`
    SELECT content, created_at
    FROM reports
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}

/** 列出所有回饋（API 用） */
export function listReports(limit = 50) {
  return db.prepare(`
    SELECT id, content, created_at
    FROM reports
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}
