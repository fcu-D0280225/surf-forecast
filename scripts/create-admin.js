/**
 * 建立管理員帳號
 * 用法：node scripts/create-admin.js <username> <password> [displayName]
 */
import { createUser, userCount } from '../src/auth.js';

const [,, username, password, displayName] = process.argv;
if (!username || !password) {
  console.error('用法：node scripts/create-admin.js <username> <password> [displayName]');
  process.exit(1);
}

try {
  createUser(username, password, displayName || username, { isAdmin: true, points: 0 });
  console.log(`✅ 管理員帳號 "${username}" 已建立（共 ${userCount()} 位用戶）`);
} catch (e) {
  if (e.message?.includes('UNIQUE')) {
    console.error(`❌ 帳號 "${username}" 已存在`);
  } else {
    console.error('❌ 錯誤：', e.message);
  }
  process.exit(1);
}
