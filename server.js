'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  // Persist an auto-generated secret so sessions survive restarts in dev.
  const f = path.join(DATA_DIR, '.jwt_secret');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
})();
const COOKIE = 'kb_session';
const SECURE_COOKIE = process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIE !== '1';

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'kinbubble.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS trees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  share_token TEXT NOT NULL UNIQUE,
  share_mode TEXT NOT NULL DEFAULT 'private', -- private | link-view | link-edit
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tree_members (
  tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer', -- editor | viewer
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tree_id, email)
);
CREATE TABLE IF NOT EXISTS persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  maiden_name TEXT NOT NULL DEFAULT '',
  nickname TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT '', -- male | female | other | ''
  birth_date TEXT NOT NULL DEFAULT '',
  death_date TEXT NOT NULL DEFAULT '',
  birth_place TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  occupation TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_persons_tree ON persons(tree_id);
CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- parent (from=parent, to=child) | spouse
  from_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  UNIQUE (tree_id, type, from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_rel_tree ON relationships(tree_id);
`);

// ---------- helpers ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const normEmail = e => String(e || '').trim().toLowerCase();
const clean = (v, max = 500) => String(v == null ? '' : v).trim().slice(0, max);

function slugify(name) {
  const base = clean(name, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tree';
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}
function setSession(res, user) {
  const token = jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIE, maxAge: 30 * 864e5 });
}
function publicUser(u) { return { id: u.id, email: u.email, name: u.name, created_at: u.created_at }; }

// attach req.user when a valid session cookie exists
app.use((req, _res, next) => {
  const t = req.cookies[COOKIE];
  if (t) {
    try {
      const p = jwt.verify(t, JWT_SECRET);
      req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(p.uid) || null;
    } catch { req.user = null; }
  }
  next();
});
const requireAuth = (req, _res, next) => req.user ? next() : next(new HttpError(401, 'Please log in'));

// Resolve what the current requester may do with a tree: owner | editor | viewer | null
function accessFor(tree, req) {
  if (!tree) return null;
  if (req.user && req.user.id === tree.owner_id) return 'owner';
  if (req.user) {
    const m = db.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND email = ?').get(tree.id, req.user.email);
    if (m) return m.role;
  }
  const share = req.query.share || req.get('x-share-token');
  if (share && share === tree.share_token) {
    if (tree.share_mode === 'link-edit') return 'editor';
    if (tree.share_mode === 'link-view') return 'viewer';
  }
  return null;
}
const canEdit = a => a === 'owner' || a === 'editor';

function loadTree(req, minAccess) {
  const tree = db.prepare('SELECT * FROM trees WHERE slug = ?').get(req.params.slug);
  if (!tree) throw new HttpError(404, 'Tree not found');
  const access = accessFor(tree, req);
  if (!access) throw new HttpError(req.user ? 403 : 401, req.user ? 'You do not have access to this tree' : 'Please log in');
  if (minAccess === 'edit' && !canEdit(access)) throw new HttpError(403, 'View-only access');
  if (minAccess === 'owner' && access !== 'owner') throw new HttpError(403, 'Only the owner can do that');
  return { tree, access };
}
function touch(treeId) { db.prepare("UPDATE trees SET updated_at = ? WHERE id = ?").run(now(), treeId); }

const PERSON_FIELDS = ['first_name', 'last_name', 'maiden_name', 'nickname', 'gender', 'birth_date', 'death_date',
  'birth_place', 'location', 'occupation', 'bio', 'photo_url', 'tags'];
function personInput(body, partial = false) {
  const out = {};
  for (const f of PERSON_FIELDS) {
    if (partial && !(f in body)) continue;
    out[f] = clean(body[f], f === 'bio' ? 4000 : f === 'photo_url' ? 2000 : 200);
  }
  if (!partial && !out.first_name) throw new HttpError(400, 'First name is required');
  if ('first_name' in out && !out.first_name) throw new HttpError(400, 'First name cannot be empty');
  if ('gender' in out && !['', 'male', 'female', 'other'].includes(out.gender)) throw new HttpError(400, 'Invalid gender');
  return out;
}
function treePayload(tree, access) {
  const persons = db.prepare('SELECT * FROM persons WHERE tree_id = ? ORDER BY id').all(tree.id);
  const relationships = db.prepare('SELECT * FROM relationships WHERE tree_id = ? ORDER BY id').all(tree.id);
  const t = { id: tree.id, slug: tree.slug, name: tree.name, description: tree.description, share_mode: tree.share_mode,
    created_at: tree.created_at, updated_at: tree.updated_at, owner_id: tree.owner_id, access };
  if (access === 'owner') {
    t.share_token = tree.share_token;
    t.members = db.prepare('SELECT email, role, added_at FROM tree_members WHERE tree_id = ? ORDER BY added_at').all(tree.id);
  }
  return { tree: t, persons, relationships };
}

// ---------- auth ----------
app.post('/api/auth/register', wrap((req, res) => {
  const email = normEmail(req.body.email), name = clean(req.body.name, 80), password = String(req.body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
  if (!name) throw new HttpError(400, 'Name is required');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'An account with that email already exists');
  const info = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run(email, name, bcrypt.hashSync(password, 10));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  setSession(res, user);
  res.status(201).json({ user: publicUser(user) });
}));
app.post('/api/auth/login', wrap((req, res) => {
  const email = normEmail(req.body.email), password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) throw new HttpError(401, 'Wrong email or password');
  setSession(res, user);
  res.json({ user: publicUser(user) });
}));
app.post('/api/auth/logout', (req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));
app.patch('/api/auth/me', requireAuth, wrap((req, res) => {
  const name = clean(req.body.name, 80);
  if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  if (req.body.new_password) {
    if (!bcrypt.compareSync(String(req.body.current_password || ''), req.user.password_hash)) throw new HttpError(401, 'Current password is wrong');
    if (String(req.body.new_password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(req.body.new_password), 10), req.user.id);
  }
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
}));

// ---------- trees ----------
app.get('/api/trees', requireAuth, wrap((req, res) => {
  const rows = db.prepare(`
    SELECT t.id, t.slug, t.name, t.description, t.share_mode, t.created_at, t.updated_at, t.owner_id,
           u.name AS owner_name,
           CASE WHEN t.owner_id = @uid THEN 'owner' ELSE m.role END AS access,
           (SELECT COUNT(*) FROM persons p WHERE p.tree_id = t.id) AS person_count
    FROM trees t
    JOIN users u ON u.id = t.owner_id
    LEFT JOIN tree_members m ON m.tree_id = t.id AND m.email = @email
    WHERE t.owner_id = @uid OR m.email IS NOT NULL
    ORDER BY t.updated_at DESC`).all({ uid: req.user.id, email: req.user.email });
  res.json({ trees: rows });
}));
app.post('/api/trees', requireAuth, wrap((req, res) => {
  const name = clean(req.body.name, 80) || 'My Family Tree';
  const description = clean(req.body.description, 1000);
  const slug = slugify(name);
  const info = db.prepare('INSERT INTO trees (slug, name, description, owner_id, share_token) VALUES (?, ?, ?, ?, ?)')
    .run(slug, name, description, req.user.id, crypto.randomBytes(16).toString('hex'));
  const tree = db.prepare('SELECT * FROM trees WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(treePayload(tree, 'owner'));
}));
app.get('/api/trees/:slug', wrap((req, res) => {
  const { tree, access } = loadTree(req);
  res.json(treePayload(tree, access));
}));
app.patch('/api/trees/:slug', requireAuth, wrap((req, res) => {
  const { tree } = loadTree(req, 'owner');
  const name = 'name' in req.body ? clean(req.body.name, 80) || tree.name : tree.name;
  const description = 'description' in req.body ? clean(req.body.description, 1000) : tree.description;
  let share_mode = tree.share_mode;
  if ('share_mode' in req.body) {
    if (!['private', 'link-view', 'link-edit'].includes(req.body.share_mode)) throw new HttpError(400, 'Invalid share mode');
    share_mode = req.body.share_mode;
  }
  db.prepare('UPDATE trees SET name = ?, description = ?, share_mode = ?, updated_at = ? WHERE id = ?').run(name, description, share_mode, now(), tree.id);
  res.json(treePayload(db.prepare('SELECT * FROM trees WHERE id = ?').get(tree.id), 'owner'));
}));
app.post('/api/trees/:slug/share/rotate', requireAuth, wrap((req, res) => {
  const { tree } = loadTree(req, 'owner');
  db.prepare('UPDATE trees SET share_token = ? WHERE id = ?').run(crypto.randomBytes(16).toString('hex'), tree.id);
  res.json(treePayload(db.prepare('SELECT * FROM trees WHERE id = ?').get(tree.id), 'owner'));
}));
app.delete('/api/trees/:slug', requireAuth, wrap((req, res) => {
  const { tree } = loadTree(req, 'owner');
  db.prepare('DELETE FROM trees WHERE id = ?').run(tree.id);
  res.json({ ok: true });
}));

// members (invite by email; they see the tree once they log in with that email)
app.post('/api/trees/:slug/members', requireAuth, wrap((req, res) => {
  const { tree } = loadTree(req, 'owner');
  const email = normEmail(req.body.email);
  const role = req.body.role === 'editor' ? 'editor' : 'viewer';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
  if (email === req.user.email) throw new HttpError(400, 'You already own this tree');
  db.prepare('INSERT INTO tree_members (tree_id, email, role) VALUES (?, ?, ?) ON CONFLICT(tree_id, email) DO UPDATE SET role = excluded.role').run(tree.id, email, role);
  res.json(treePayload(tree, 'owner'));
}));
app.delete('/api/trees/:slug/members/:email', requireAuth, wrap((req, res) => {
  const { tree } = loadTree(req, 'owner');
  db.prepare('DELETE FROM tree_members WHERE tree_id = ? AND email = ?').run(tree.id, normEmail(req.params.email));
  res.json(treePayload(tree, 'owner'));
}));
// Leave a tree you were invited to
app.post('/api/trees/:slug/leave', requireAuth, wrap((req, res) => {
  const { tree, access } = loadTree(req);
  if (access === 'owner') throw new HttpError(400, 'Owners cannot leave their own tree; delete it instead');
  db.prepare('DELETE FROM tree_members WHERE tree_id = ? AND email = ?').run(tree.id, req.user.email);
  res.json({ ok: true });
}));

// ---------- persons ----------
app.post('/api/trees/:slug/persons', wrap((req, res) => {
  const { tree } = loadTree(req, 'edit');
  const p = personInput(req.body);
  const cols = Object.keys(p);
  const info = db.prepare(`INSERT INTO persons (tree_id, ${cols.join(',')}) VALUES (?, ${cols.map(() => '?').join(',')})`).run(tree.id, ...cols.map(c => p[c]));
  const person = db.prepare('SELECT * FROM persons WHERE id = ?').get(info.lastInsertRowid);
  const rels = [];
  // Optional quick-links when adding a relative from the UI
  const link = req.body.link; // { type: 'parent'|'child'|'spouse', person_id }
  if (link && link.person_id) {
    const other = db.prepare('SELECT id FROM persons WHERE id = ? AND tree_id = ?').get(link.person_id, tree.id);
    if (other) {
      const add = (type, a, b) => {
        const r = db.prepare('INSERT OR IGNORE INTO relationships (tree_id, type, from_id, to_id) VALUES (?, ?, ?, ?)').run(tree.id, type, a, b);
        if (r.changes) rels.push(db.prepare('SELECT * FROM relationships WHERE id = ?').get(r.lastInsertRowid));
      };
      if (link.type === 'parent') add('parent', person.id, other.id);       // new person is parent of other
      else if (link.type === 'child') add('parent', other.id, person.id);   // new person is child of other
      else if (link.type === 'spouse') add('spouse', other.id, person.id);
      else if (link.type === 'sibling') {                                    // share other's parents
        for (const pr of db.prepare("SELECT from_id FROM relationships WHERE tree_id = ? AND type = 'parent' AND to_id = ?").all(tree.id, other.id)) add('parent', pr.from_id, person.id);
      }
    }
  }
  touch(tree.id);
  res.status(201).json({ person, relationships: rels });
}));
app.patch('/api/trees/:slug/persons/:id', wrap((req, res) => {
  const { tree } = loadTree(req, 'edit');
  const existing = db.prepare('SELECT * FROM persons WHERE id = ? AND tree_id = ?').get(req.params.id, tree.id);
  if (!existing) throw new HttpError(404, 'Person not found');
  const p = personInput(req.body, true);
  const cols = Object.keys(p);
  if (cols.length) {
    db.prepare(`UPDATE persons SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map(c => p[c]), now(), existing.id);
    touch(tree.id);
  }
  res.json({ person: db.prepare('SELECT * FROM persons WHERE id = ?').get(existing.id) });
}));
app.delete('/api/trees/:slug/persons/:id', wrap((req, res) => {
  const { tree } = loadTree(req, 'edit');
  const r = db.prepare('DELETE FROM persons WHERE id = ? AND tree_id = ?').run(req.params.id, tree.id);
  if (!r.changes) throw new HttpError(404, 'Person not found');
  touch(tree.id);
  res.json({ ok: true });
}));

// ---------- relationships ----------
app.post('/api/trees/:slug/relationships', wrap((req, res) => {
  const { tree } = loadTree(req, 'edit');
  const type = req.body.type;
  let from_id = Number(req.body.from_id), to_id = Number(req.body.to_id);
  if (!['parent', 'spouse'].includes(type)) throw new HttpError(400, 'Type must be parent or spouse');
  if (!from_id || !to_id || from_id === to_id) throw new HttpError(400, 'Pick two different people');
  const inTree = id => db.prepare('SELECT 1 FROM persons WHERE id = ? AND tree_id = ?').get(id, tree.id);
  if (!inTree(from_id) || !inTree(to_id)) throw new HttpError(404, 'Person not found in this tree');
  if (type === 'spouse' && from_id > to_id) [from_id, to_id] = [to_id, from_id]; // canonical order avoids duplicates
  if (type === 'parent') {
    // prevent cycles: to_id must not be an ancestor of from_id
    const seen = new Set(); const stack = [from_id];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === to_id) throw new HttpError(400, 'That would make someone their own ancestor');
      for (const r of db.prepare("SELECT from_id FROM relationships WHERE tree_id = ? AND type = 'parent' AND to_id = ?").all(tree.id, cur)) {
        if (!seen.has(r.from_id)) { seen.add(r.from_id); stack.push(r.from_id); }
      }
    }
  }
  const r = db.prepare('INSERT OR IGNORE INTO relationships (tree_id, type, from_id, to_id, note) VALUES (?, ?, ?, ?, ?)').run(tree.id, type, from_id, to_id, clean(req.body.note, 200));
  const rel = r.changes ? db.prepare('SELECT * FROM relationships WHERE id = ?').get(r.lastInsertRowid)
    : db.prepare('SELECT * FROM relationships WHERE tree_id = ? AND type = ? AND from_id = ? AND to_id = ?').get(tree.id, type, from_id, to_id);
  touch(tree.id);
  res.status(201).json({ relationship: rel });
}));
app.delete('/api/trees/:slug/relationships/:id', wrap((req, res) => {
  const { tree } = loadTree(req, 'edit');
  const r = db.prepare('DELETE FROM relationships WHERE id = ? AND tree_id = ?').run(req.params.id, tree.id);
  if (!r.changes) throw new HttpError(404, 'Relationship not found');
  touch(tree.id);
  res.json({ ok: true });
}));

// ---------- search ----------
// GET /api/search?q=...&tree=slug&share=token  (tree optional: searches every tree you can access)
app.get('/api/search', wrap((req, res) => {
  const q = clean(req.query.q, 100);
  const field = clean(req.query.field, 20); // optional: name | family | details | any
  if (!q) return res.json({ results: [] });
  let treeIds = [];
  if (req.query.tree) {
    const { tree } = loadTree({ ...req, params: { slug: req.query.tree } });
    treeIds = [tree.id];
  } else if (req.user) {
    treeIds = db.prepare(`SELECT t.id FROM trees t LEFT JOIN tree_members m ON m.tree_id = t.id AND m.email = ?
                          WHERE t.owner_id = ? OR m.email IS NOT NULL`).all(req.user.email, req.user.id).map(r => r.id);
  } else throw new HttpError(401, 'Please log in');
  if (!treeIds.length) return res.json({ results: [] });
  const like = `%${q.replace(/[%_]/g, c => '\\' + c)}%`;
  const nameCols = ['first_name', 'nickname', 'maiden_name'];
  const familyCols = ['last_name', 'maiden_name'];
  const detailCols = ['birth_place', 'location', 'occupation', 'bio', 'tags', 'birth_date', 'death_date'];
  let cols = [...nameCols, ...familyCols, ...detailCols];
  if (field === 'name') cols = nameCols; else if (field === 'family') cols = familyCols; else if (field === 'details') cols = detailCols;
  const where = cols.map(c => `${c} LIKE ? ESCAPE '\\'`).join(' OR ');
  const fullName = field === 'name' || field === 'any' || !field ? ` OR (first_name || ' ' || last_name) LIKE ? ESCAPE '\\'` : '';
  const rows = db.prepare(`
    SELECT p.*, t.slug AS tree_slug, t.name AS tree_name
    FROM persons p JOIN trees t ON t.id = p.tree_id
    WHERE p.tree_id IN (${treeIds.map(() => '?').join(',')}) AND (${where}${fullName})
    ORDER BY p.last_name, p.first_name LIMIT 100`).all(...treeIds, ...cols.map(() => like), ...(fullName ? [like] : []));
  res.json({ results: rows });
}));

// ---------- static + SPA ----------
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));
app.get(/^\/(t\/[^/]+)?$/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

// error handler
app.use((err, _req, res, _next) => {
  if (!(err instanceof HttpError)) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong' });
});

app.listen(PORT, () => console.log(`KinBubble running on http://localhost:${PORT}  (data: ${DATA_DIR})`));
