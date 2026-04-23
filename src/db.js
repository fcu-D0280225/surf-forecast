/**
 * db.js — MySQL connection pool and schema initialization
 */
import mysql from 'mysql2/promise';

const config = {
  host:     process.env.MYSQL_HOST     || 'localhost',
  port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
  user:     process.env.MYSQL_USER     || 'app_user',
  password: process.env.MYSQL_PASSWORD || 'AppUser@2026!',
  database: process.env.MYSQL_DATABASE || 'surf_forecast',
  connectionLimit: 10,
  waitForConnections: true,
  dateStrings: true,
};

const pool = mysql.createPool(config);

let initPromise = null;

async function createSchema(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(64)  NOT NULL UNIQUE,
      display_name  VARCHAR(128) NOT NULL,
      password_hash VARCHAR(256) NOT NULL,
      is_admin      TINYINT NOT NULL DEFAULT 0,
      points        INT     NOT NULL DEFAULT 0,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token        VARCHAR(128) NOT NULL PRIMARY KEY,
      user_id      INT NOT NULL,
      username     VARCHAR(64)  NOT NULL,
      display_name VARCHAR(128) NOT NULL,
      expires_at   DATETIME NOT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      content    TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS surf_log (
      id                   INT AUTO_INCREMENT PRIMARY KEY,
      date_iso             VARCHAR(10) NOT NULL,
      spot                 VARCHAR(255) NOT NULL,
      rating               VARCHAR(16)  NOT NULL,
      notes                TEXT,
      content              TEXT NOT NULL,
      embedding            LONGBLOB NULL,
      created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      wave_height_m        DOUBLE,
      wave_period_s        DOUBLE,
      wind_speed_kmh       DOUBLE,
      wind_direction_deg   DOUBLE,
      wind_direction_text  VARCHAR(32),
      swell_height_m       DOUBLE,
      swell_period_s       DOUBLE,
      wave_direction_deg   DOUBLE,
      wave_direction_text  VARCHAR(32),
      water_temp_c         DOUBLE,
      weather_text         VARCHAR(64),
      tide                 VARCHAR(128),
      INDEX idx_surf_log_date (date_iso)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await conn.query(`ALTER TABLE surf_log MODIFY embedding LONGBLOB NULL`);
}

export async function initDb() {
  if (!initPromise) {
    initPromise = (async () => {
      const conn = await pool.getConnection();
      try {
        await createSchema(conn);
      } finally {
        conn.release();
      }
    })();
  }
  return initPromise;
}

/** Run a query and return rows (SELECT) or result metadata (INSERT/UPDATE). */
export async function run(sql, params = []) {
  await initDb();
  const [result] = await pool.execute(sql, params);
  return result;
}

/** Convenience: return first row or undefined. */
export async function first(sql, params = []) {
  const rows = await run(sql, params);
  return Array.isArray(rows) ? rows[0] : undefined;
}

/** Convenience: return all rows. */
export async function all(sql, params = []) {
  const rows = await run(sql, params);
  return Array.isArray(rows) ? rows : [];
}

export { pool };
