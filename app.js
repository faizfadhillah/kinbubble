'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  if (process.env.DATABASE_URL || process.env.POSTGRES_URL) {
    // Serverless hosts have no writable disk: derive a stable secret. Set JWT_SECRET explicitly in production.
    console.warn('JWT_SECRET is not set; deriving one from the database URL. Set JWT_SECRET in your host env for best security.');
    return crypto.createHash('sha256').update('kinbubble|' + (process.env.DATABASE_URL || process.env.POSTGRES_URL)).digest('hex');
  }
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
  const f = path.join(DATA_DIR, '.jwt_secret');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
})();
const COOKIE = 'kb_session';
const SECURE_COOKIE = (process.env.NODE_ENV === 'production' || !!process.env.VERCEL) && process.env.INSECURE_COOKIE !== '1';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const normEmail = e => String(e || '').trim().toLowerCase();
const clean = (v, max = 500) => String(v == null ? '' : v).trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function slugify(name) {
  const base = clean(name, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tree';
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}
function setSession(res, user) {
  const token = jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIE, maxAge: 30 * 864e5 });
}
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, created_at: u.created_at });

// ensure schema exists (once per process), then attach req.user from the session cookie
app.use(wrap(async (req, _res, next) => {
  await db.ready();
  const t = req.cookies[COOKIE];
  if (t) {
    try {
      const p = jwt.verify(t, JWT_SECRET);
      req.user = await db.get('SELECT * FROM users WHERE id = $1', [p.uid]);
    } catch { req.user = null; }
  }
  next();
}));
const requireAuth = (req, _res, next) => req.user ? next() : next(new HttpError(401, 'Please log in'));

async function accessFor(tree, req) {
  if (!tree) return null;
  if (req.user && req.user.id === tree.owner_id) return 'owner';
  if (req.user) {
    const m = await db.get('SELECT role FROM tree_members WHERE tree_id = $1 AND email = $2', [tree.id, req.user.email]);
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

async function loadTree(req, minAccess, slug = req.params.slug) {
  const tree = await db.get('SELECT * FROM trees WHERE slug = $1', [slug]);
  if (!tree) throw new HttpError(404, 'Tree not found');
  const access = await accessFor(tree, req);
  if (!access) throw new HttpError(req.user ? 403 : 401, req.user ? 'You do not have access to this tree' : 'Please log in');
  if (minAccess === 'edit' && !canEdit(access)) throw new HttpError(403, 'View-only access');
  if (minAccess === 'owner' && access !== 'owner') throw new HttpError(403, 'Only the owner can do that');
  return { tree, access };
}
const touch = treeId => db.run('UPDATE trees SET updated_at = $1 WHERE id = $2', [now(), treeId]);
const getTree = id => db.get('SELECT * FROM trees WHERE id = $1', [id]);

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
async function treePayload(tree, access) {
  const persons = await db.all('SELECT * FROM persons WHERE tree_id = $1 ORDER BY id', [tree.id]);
  const relationships = await db.all('SELECT * FROM relationships WHERE tree_id = $1 ORDER BY id', [tree.id]);
  const t = { id: tree.id, slug: tree.slug, name: tree.name, description: tree.description, share_mode: tree.share_mode,
    created_at: tree.created_at, updated_at: tree.updated_at, owner_id: tree.owner_id, access };
  if (access === 'owner') {
    t.share_token = tree.share_token;
    t.members = await db.all('SELECT email, role, added_at FROM tree_members WHERE tree_id = $1 ORDER BY added_at', [tree.id]);
  }
  return { tree: t, persons, relationships };
}

// ---------- auth ----------
app.post('/api/auth/register', wrap(async (req, res) => {
  const email = normEmail(req.body.email), name = clean(req.body.name, 80), password = String(req.body.password || '');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email');
  if (!name) throw new HttpError(400, 'Name is required');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (await db.get('SELECT 1 FROM users WHERE email = $1', [email])) throw new HttpError(409, 'An account with that email already exists');
  const { row: user } = await db.run('INSERT INTO users (email, name, password_hash, created_at) VALUES ($1, $2, $3, $4) RETURNING *', [email, name, bcrypt.hashSync(password, 10), now()]);
  setSession(res, user);
  res.status(201).json({ user: publicUser(user) });
}));
app.post('/api/auth/login', wrap(async (req, res) => {
  const email = normEmail(req.body.email), password = String(req.body.password || '');
  const user = await db.get('SELECT * FROM users WHERE email = $1', [email]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) throw new HttpError(401, 'Wrong email or password');
  setSession(res, user);
  res.json({ user: publicUser(user) });
}));
app.post('/api/auth/logout', (req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));
app.patch('/api/auth/me', requireAuth, wrap(async (req, res) => {
  const name = clean(req.body.name, 80);
  if (name) await db.run('UPDATE users SET name = $1 WHERE id = $2', [name, req.user.id]);
  if (req.body.new_password) {
    if (!bcrypt.compareSync(String(req.body.current_password || ''), req.user.password_hash)) throw new HttpError(401, 'Current password is wrong');
    if (String(req.body.new_password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    await db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(String(req.body.new_password), 10), req.user.id]);
  }
  res.json({ user: publicUser(await db.get('SELECT * FROM users WHERE id = $1', [req.user.id])) });
}));

// ---------- trees ----------
app.get('/api/trees', requireAuth, wrap(async (req, res) => {
  const rows = await db.all(`
    SELECT t.id, t.slug, t.name, t.description, t.share_mode, t.created_at, t.updated_at, t.owner_id,
           u.name AS owner_name,
           CASE WHEN t.owner_id = $1 THEN 'owner' ELSE m.role END AS access,
           (SELECT COUNT(*) FROM persons p WHERE p.tree_id = t.id) AS person_count
    FROM trees t
    JOIN users u ON u.id = t.owner_id
    LEFT JOIN tree_members m ON m.tree_id = t.id AND m.email = $2
    WHERE t.owner_id = $1 OR m.email IS NOT NULL
    ORDER BY t.updated_at DESC`, [req.user.id, req.user.email]);
  rows.forEach(r => r.person_count = Number(r.person_count));
  res.json({ trees: rows });
}));
app.post('/api/trees', requireAuth, wrap(async (req, res) => {
  const name = clean(req.body.name, 80) || 'My Family Tree';
  const description = clean(req.body.description, 1000);
  const ts = now();
  const { row: tree } = await db.run('INSERT INTO trees (slug, name, description, owner_id, share_token, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *',
    [slugify(name), name, description, req.user.id, crypto.randomBytes(16).toString('hex'), ts]);
  res.status(201).json(await treePayload(tree, 'owner'));
}));
app.get('/api/trees/:slug', wrap(async (req, res) => {
  const { tree, access } = await loadTree(req);
  res.json(await treePayload(tree, access));
}));
app.patch('/api/trees/:slug', requireAuth, wrap(async (req, res) => {
  const { tree } = await loadTree(req, 'owner');
  const name = 'name' in req.body ? clean(req.body.name, 80) || tree.name : tree.name;
  const description = 'description' in req.body ? clean(req.body.description, 1000) : tree.description;
  let share_mode = tree.share_mode;
  if ('share_mode' in req.body) {
    if (!['private', 'link-view', 'link-edit'].includes(req.body.share_mode)) throw new HttpError(400, 'Invalid share mode');
    share_mode = req.body.share_mode;
  }
  await db.run('UPDATE trees SET name = $1, description = $2, share_mode = $3, updated_at = $4 WHERE id = $5', [name, description, share_mode, now(), tree.id]);
  res.json(await treePayload(await getTree(tree.id), 'owner'));
}));
app.post('/api/trees/:slug/share/rotate', requireAuth, wrap(async (req, res) => {
  const { tree } = await loadTree(req, 'owner');
  await db.run('UPDATE trees SET share_token = $1 WHERE id = $2', [crypto.randomBytes(16).toString('hex'), tree.id]);
  res.json(await treePayload(await getTree(tree.id), 'owner'));
}));
app.delete('/api/trees/:slug', requireAuth, wrap(async (req, res) => {
  const { tree } = await loadTree(req, 'owner');
  await db.run('DELETE FROM trees WHERE id = $1', [tree.id]);
  res.json({ ok: true });
}));

// members
app.post('/api/trees/:slug/members', requireAuth, wrap(async (req, res) => {
  const { tree } = await loadTree(req, 'owner');
  const email = normEmail(req.body.email);
  const role = req.body.role === 'editor' ? 'editor' : 'viewer';
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email');
  if (email === req.user.email) throw new HttpError(400, 'You already own this tree');
  await db.run('INSERT INTO tree_members (tree_id, email, role, added_at) VALUES ($1, $2, $3, $4) ON CONFLICT(tree_id, email) DO UPDATE SET role = excluded.role', [tree.id, email, role, now()]);
  res.json(await treePayload(tree, 'owner'));
}));
app.delete('/api/trees/:slug/members/:email', requireAuth, wrap(async (req, res) => {
  const { tree } = await loadTree(req, 'owner');
  await db.run('DELETE FROM tree_members WHERE tree_id = $1 AND email = $2', [tree.id, normEmail(req.params.email)]);
  res.json(await treePayload(tree, 'owner'));
}));
app.post('/api/trees/:slug/leave', requireAuth, wrap(async (req, res) => {
  const { tree, access } = await loadTree(req);
  if (access === 'owner') throw new HttpError(400, 'Owners cannot leave their own tree; delete it instead');
  await db.run('DELETE FROM tree_members WHERE tree_id = $1 AND email = $2', [tree.id, req.user.email]);
  res.json({ ok: true });
}));

// ---------- persons ----------
const addRel = async (treeId, type, a, b) => {
  const { row } = await db.run('INSERT INTO relationships (tree_id, type, from_id, to_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING *', [treeId, type, a, b]);
  return row;
};
app.post('/api/trees/:slug/persons', wrap(async (req, res) => {
  const { tree } = await loadTree(req, 'edit');
  const p = personInput(req.body);
  const cols = Object.keys(p);
  const ts = now();
  const { row: person } = await db.run(
    `INSERT INTO persons (tree_id, ${cols.join(',')}, created_at, updated_at) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(',')}, $${cols.length + 2}, $${cols.length + 2}) RETURNING *`,
    [tree.id, ...cols.map(c => p[c]), ts]);
  const rels = [];
  const link = req.body.link; // { type: 'parent'|'child'|'spouse'|'sibling', person_id }
  if (link && link.person_id) {
    const other = await db.get('SELECT id FROM persons WHERE id = $1 AND tree_id = $2', [Number(link.person_id) || 0, tree.id]);
    if (other) {
      const push = r => { if (r) rels.push(r); };
      if (link.type === 'parent') push(await addRel(tree.id, 'parent', person.id, other.id));
      else if (link.type === 'child') push(await addRel(tree.id, 'parent', other.id, person.id));
      else if (link.type === 'spouse') push(await addRel(tree.id, 'spouse', Math.min(other.id, person.id), Math.max(other.id, person.id)));
      else if (link.type === 'sibling') {
        const parents = await db.all("SELECT from_id FROM relationships WHERE tree_id = $1 AND type = 'parent' AND to_id = $2", [tree.id, other.id]);
        for (const pr of parents) push(await addRel(tree.id, 'parent', pr.from_id, person.id));
      }
    }
  }
  await touch(tree.id);
  res.status(201).json({ person, relationships: rels });
}));
app.patch('/api/trees/:slug/persons/:id', wrap(async (req, res) => {
  const { tree } = await loadTree(req, 'edit');
  const existing = await db.get('SELECT * FROM persons WHERE id = $1 AND tree_id = $2', [Number(req.params.id) || 0, tree.id]);
  if (!existing) throw new HttpError(404, 'Person not found');
  const p = personInput(req.body, true);
  const cols = Object.keys(p);
  if (cols.length) {
    await db.run(`UPDATE persons SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = $${cols.length + 1} WHERE id = $${cols.length + 2}`, [...cols.map(c => p[c]), now(), existing.id]);
    await touch(tree.id);
  }
  res.json({ person: await db.get('SELECT * FROM persons WHERE id = $1', [existing.id]) });
}));
app.delete('/api/trees/:slug/persons/:id', wrap(async (req, res) => {
  const { tree } = await loadTree(req, 'edit');
  const r = await db.run('DELETE FROM persons WHERE id = $1 AND tree_id = $2', [Number(req.params.id) || 0, tree.id]);
  if (!r.changes) throw new HttpError(404, 'Person not found');
  await touch(tree.id);
  res.json({ ok: true });
}));

// ---------- relationships ----------
app.post('/api/trees/:slug/relationships', wrap(async (req, res) => {
  const { tree } = await loadTree(req, 'edit');
  const type = req.body.type;
  let from_id = Number(req.body.from_id), to_id = Number(req.body.to_id);
  if (!['parent', 'spouse'].includes(type)) throw new HttpError(400, 'Type must be parent or spouse');
  if (!from_id || !to_id || from_id === to_id) throw new HttpError(400, 'Pick two different people');
  const inTree = id => db.get('SELECT 1 FROM persons WHERE id = $1 AND tree_id = $2', [id, tree.id]);
  if (!(await inTree(from_id)) || !(await inTree(to_id))) throw new HttpError(404, 'Person not found in this tree');
  if (type === 'spouse' && from_id > to_id) [from_id, to_id] = [to_id, from_id];
  if (type === 'parent') {
    // prevent cycles: to_id must not be an ancestor of from_id
    const parentRows = await db.all("SELECT from_id, to_id FROM relationships WHERE tree_id = $1 AND type = 'parent'", [tree.id]);
    const parentsOf = new Map();
    for (const r of parentRows) { if (!parentsOf.has(r.to_id)) parentsOf.set(r.to_id, []); parentsOf.get(r.to_id).push(r.from_id); }
    const seen = new Set(); const stack = [from_id];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === to_id) throw new HttpError(400, 'That would make someone their own ancestor');
      for (const pid of parentsOf.get(cur) || []) if (!seen.has(pid)) { seen.add(pid); stack.push(pid); }
    }
  }
  const { row } = await db.run('INSERT INTO relationships (tree_id, type, from_id, to_id, note) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING *', [tree.id, type, from_id, to_id, clean(req.body.note, 200)]);
  const rel = row || await db.get('SELECT * FROM relationships WHERE tree_id = $1 AND type = $2 AND from_id = $3 AND to_id = $4', [tree.id, type, from_id, to_id]);
  await touch(tree.id);
  res.status(201).json({ relationship: rel });
}));
app.delete('/api/trees/:slug/relationships/:id', wrap(async (req, res) => {
  const { tree } = await loadTree(req, 'edit');
  const r = await db.run('DELETE FROM relationships WHERE id = $1 AND tree_id = $2', [Number(req.params.id) || 0, tree.id]);
  if (!r.changes) throw new HttpError(404, 'Relationship not found');
  await touch(tree.id);
  res.json({ ok: true });
}));

// ---------- search ----------
app.get('/api/search', wrap(async (req, res) => {
  const q = clean(req.query.q, 100);
  const field = clean(req.query.field, 20);
  if (!q) return res.json({ results: [] });
  let treeIds = [];
  if (req.query.tree) {
    const { tree } = await loadTree(req, null, String(req.query.tree));
    treeIds = [tree.id];
  } else if (req.user) {
    treeIds = (await db.all(`SELECT t.id FROM trees t LEFT JOIN tree_members m ON m.tree_id = t.id AND m.email = $1
                             WHERE t.owner_id = $2 OR m.email IS NOT NULL`, [req.user.email, req.user.id])).map(r => r.id);
  } else throw new HttpError(401, 'Please log in');
  if (!treeIds.length) return res.json({ results: [] });
  const like = `%${q.replace(/[!%_]/g, c => '!' + c)}%`;
  const nameCols = ['first_name', 'nickname', 'maiden_name'];
  const familyCols = ['last_name', 'maiden_name'];
  const detailCols = ['birth_place', 'location', 'occupation', 'bio', 'tags', 'birth_date', 'death_date'];
  let cols = [...nameCols, ...familyCols, ...detailCols];
  if (field === 'name') cols = nameCols; else if (field === 'family') cols = familyCols; else if (field === 'details') cols = detailCols;
  const withFull = field === 'name' || field === 'any' || !field;
  const params = [...treeIds];
  const inList = treeIds.map((_, i) => `$${i + 1}`).join(',');
  params.push(like);
  const likeIdx = params.length;
  const where = cols.map(c => `${c} ILIKE $${likeIdx} ESCAPE '!'`).concat(withFull ? [`(first_name || ' ' || last_name) ILIKE $${likeIdx} ESCAPE '!'`] : []).join(' OR ');
  const rows = await db.all(`
    SELECT p.*, t.slug AS tree_slug, t.name AS tree_name
    FROM persons p JOIN trees t ON t.id = p.tree_id
    WHERE p.tree_id IN (${inList}) AND (${where})
    ORDER BY p.last_name, p.first_name LIMIT 100`, params);
  res.json({ results: rows });
}));

// ---------- static + SPA ----------
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));
app.get(/^\/(t\/[^/]+)?$/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

app.use((err, _req, res, _next) => {
  if (!(err instanceof HttpError)) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong' });
});

module.exports = app;
