/**
 * rag-db.js — 用戶浪況回饋 RAG 儲存（MySQL 版）
 * 自由文字，不強制綁定浪點或日期格式，原文存入，Claude 自行解讀。
 */
import { run, all } from './db.js';

/** 新增一筆自由文字回饋 */
export async function insertReport(content) {
  await run(`INSERT INTO reports (content) VALUES (?)`, [content.trim()]);
}

/** 取最近 N 筆回饋（供 Claude prompt 使用） */
export async function getRecentReports(limit = 15) {
  const n = parseInt(limit, 10);
  return all(`SELECT content, created_at FROM reports ORDER BY id DESC LIMIT ${n}`);
}

/** 列出所有回饋（API 用） */
export async function listReports(limit = 50) {
  const n = parseInt(limit, 10);
  return all(`SELECT id, content, created_at FROM reports ORDER BY id DESC LIMIT ${n}`);
}
