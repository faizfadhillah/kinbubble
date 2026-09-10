'use strict';
/**
 * Tiny dual-dialect data layer.
 *  - DATABASE_URL set  -> PostgreSQL (pg Pool). Used on Vercel / Neon / Supabase / any Postgres.
 *  - otherwise         -> SQLite via better-sqlite3 in DATA_DIR (zero-config local + Docker).
 * SQL is written in Postgres style ($1, $2 …) and translated for SQLite.
 */
const path = require('path');
const fs = require('fs');

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const IS_PG = !!DATABASE_URL;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id {{ID}},
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trees (
  id {{ID}},
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  share_token TEXT NOT NULL UNIQUE,
  share_mode TEXT NOT NULL DEFAULT 'private',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tree_members (
  tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  added_at TEXT NOT NULL,
  PRIMARY KEY (tree_id, email)
);
CREATE TABLE IF NOT EXISTS persons (
  id {{ID}},
  tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  maiden_name TEXT NOT NULL DEFAULT '',
  nickname TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT '',
  birth_date TEXT NOT NULL DEFAULT '',
  death_date TEXT NOT NULL DEFAULT '',
  birth_place TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  occupation TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_persons_tree ON persons(tree_id);
CREATE TABLE IF NOT EXISTS relationships (
  id {{ID}},
  tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  from_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  UNIQUE (tree_id, type, from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_rel_tree ON relationships(tree_id);
`;

let impl;
if (IS_PG) {
  const { Pool } = require('pg');
  const local = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4, ssl: local ? undefined : { rejectUnauthorized: false } });
  impl = {
    dialect: 'pg',
    async init() { await pool.query(SCHEMA.replace(/\{\{ID\}\}/g, 'SERIAL PRIMARY KEY')); },
    async all(sql, params = []) { return (await pool.query(sql, params)).rows; },
    async get(sql, params = []) { return (await pool.query(sql, params)).rows[0] || null; },
    async run(sql, params = []) { const r = await pool.query(sql, params); return { changes: r.rowCount, row: r.rows[0] || null }; },
  };
} else {
  const Database = require('better-sqlite3');
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, 'kinbubble.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // $1,$2 -> positional ? (re-mapping params, since $N may repeat) ; ILIKE -> LIKE (SQLite LIKE is case-insensitive for ASCII)
  const cache = new Map();
  const prep = sql => {
    let s = cache.get(sql);
    if (!s) {
      const order = [];
      const text = sql.replace(/\$(\d+)/g, (_, n) => { order.push(Number(n) - 1); return '?'; }).replace(/\bILIKE\b/g, 'LIKE');
      s = { st: db.prepare(text), order }; cache.set(sql, s);
    }
    return s;
  };
  const bind = (s, params) => s.order.map(i => params[i]);
  impl = {
    dialect: 'sqlite',
    async init() { db.exec(SCHEMA.replace(/\{\{ID\}\}/g, 'INTEGER PRIMARY KEY AUTOINCREMENT')); },
    async all(sql, params = []) { const s = prep(sql); return s.st.all(...bind(s, params)); },
    async get(sql, params = []) { const s = prep(sql); return s.st.get(...bind(s, params)) || null; },
    async run(sql, params = []) {
      const s = prep(sql); const args = bind(s, params);
      if (s.st.reader) { const rows = s.st.all(...args); return { changes: rows.length, row: rows[0] || null }; }
      const r = s.st.run(...args); return { changes: r.changes, row: null };
    },
  };
}

let ready;
impl.ready = () => (ready ||= impl.init());
module.exports = impl;
