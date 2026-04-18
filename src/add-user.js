#!/usr/bin/env node
/**
 * add-user.js — 管理者 CLI：新增 / 列出 / 刪除使用者
 *
 * 新增：node src/add-user.js add <username> <password> <顯示名稱>
 * 列出：node src/add-user.js list
 * 刪除：node src/add-user.js delete <username>
 */
import { createUser, listUsers, deleteUser } from './auth.js';
import { pool } from './db.js';

const [,, cmd, ...args] = process.argv;

try {
  if (cmd === 'add') {
    const [username, password, ...nameParts] = args;
    if (!username || !password) {
      console.error('用法：node src/add-user.js add <username> <password> <顯示名稱>');
      process.exit(1);
    }
    const displayName = nameParts.join(' ') || username;
    await createUser(username, password, displayName);
    console.log(`✅ 已新增使用者：${username}（${displayName}）`);

  } else if (cmd === 'list') {
    const users = await listUsers();
    if (!users.length) { console.log('（尚無使用者）'); }
    else {
      console.log('\n使用者列表：');
      users.forEach(u =>
        console.log(`  ${u.username.padEnd(16)} ${u.display_name.padEnd(16)} 建立於 ${u.created_at}`),
      );
    }

  } else if (cmd === 'delete') {
    const [username] = args;
    if (!username) { console.error('用法：node src/add-user.js delete <username>'); process.exit(1); }
    if (await deleteUser(username)) {
      console.log(`✅ 已刪除使用者：${username}`);
    } else {
      console.error(`❌ 找不到使用者：${username}`);
      process.exit(1);
    }

  } else {
    console.log(`
Surf Forecast 使用者管理

  新增：node src/add-user.js add <username> <password> <顯示名稱>
  列出：node src/add-user.js list
  刪除：node src/add-user.js delete <username>
  `);
  }
} catch (e) {
  console.error(`❌ 失敗：${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
