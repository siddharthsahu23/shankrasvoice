// Shankra ki Awazz — backend (zero dependencies, Node 22+)
// Run: node --no-warnings server.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // change in production
const PUBLIC_DIR = path.join(__dirname, 'public');

const BUILTIN_CATEGORIES = {
  hostel: 'Hostel Warden Office',
  academics: 'Academic Affairs',
  safety: 'Campus Security',
  facilities: 'Facilities & Maintenance',
  other: 'Student Council',
};
const STATUSES = ['submitted', 'in_review', 'in_progress', 'resolved'];


// ---------- DB ----------
const db = new DatabaseSync(path.join(__dirname, 'awazz.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  team TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  anonymous INTEGER NOT NULL DEFAULT 1,
  author TEXT,
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS votes (
  issue_id INTEGER NOT NULL,
  voter TEXT NOT NULL,
  vote_type TEXT NOT NULL DEFAULT 'up',
  PRIMARY KEY (issue_id, voter)
);
CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  anonymous INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS custom_categories (
  slug TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS admin_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  response TEXT NOT NULL,
  admin_name TEXT NOT NULL DEFAULT 'Admin',
  is_public INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migrate existing DB: add columns if missing
try { db.exec(`ALTER TABLE issues ADD COLUMN downvotes INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE issues ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`); } catch {}
try { db.exec(`ALTER TABLE votes ADD COLUMN vote_type TEXT NOT NULL DEFAULT 'up'`); } catch {}

// Returns merged built-in + custom categories from DB
function getCategories() {
  const custom = {};
  try {
    for (const row of db.prepare(`SELECT slug, label FROM custom_categories ORDER BY created_at`).all()) {
      custom[row.slug] = row.label;
    }
  } catch {}
  return { ...BUILTIN_CATEGORIES, ...custom };
}

const q = {
  insertIssue: db.prepare(`INSERT INTO issues (code,title,description,category,team,anonymous,author,tags) VALUES (?,?,?,?,?,?,?,?)`),
  insertTimeline: db.prepare(`INSERT INTO timeline (issue_id,status,note) VALUES (?,?,?)`),
  byCode: db.prepare(`SELECT * FROM issues WHERE code = ?`),
  byId: db.prepare(`SELECT * FROM issues WHERE id = ?`),
  timeline: db.prepare(`SELECT status,note,created_at FROM timeline WHERE issue_id = ? ORDER BY id`),
  setStatus: db.prepare(`UPDATE issues SET status=?, updated_at=datetime('now') WHERE id=?`),
  // votes
  getVote: db.prepare(`SELECT vote_type FROM votes WHERE issue_id = ? AND voter = ?`),
  addVote: db.prepare(`INSERT INTO votes (issue_id, voter, vote_type) VALUES (?,?,?)`),
  updateVote: db.prepare(`UPDATE votes SET vote_type = ? WHERE issue_id = ? AND voter = ?`),
  removeVote: db.prepare(`DELETE FROM votes WHERE issue_id = ? AND voter = ?`),
  bumpUp: db.prepare(`UPDATE issues SET upvotes = upvotes + 1 WHERE id = ?`),
  bumpDown: db.prepare(`UPDATE issues SET downvotes = downvotes + 1 WHERE id = ?`),
  unbumpUp: db.prepare(`UPDATE issues SET upvotes = MAX(0, upvotes - 1) WHERE id = ?`),
  unbumpDown: db.prepare(`UPDATE issues SET downvotes = MAX(0, downvotes - 1) WHERE id = ?`),
  // replies
  insertReply: db.prepare(`INSERT INTO replies (issue_id, author, content, anonymous) VALUES (?,?,?,?)`),
  repliesByIssue: db.prepare(`SELECT id, author, content, anonymous, created_at FROM replies WHERE issue_id = ? ORDER BY id`),
  replyCount: db.prepare(`SELECT COUNT(*) AS n FROM replies WHERE issue_id = ?`),
  // stats & tags
  stats: db.prepare(`SELECT status, COUNT(*) AS n FROM issues GROUP BY status`),
  avgResolve: db.prepare(`SELECT AVG(julianday(updated_at) - julianday(created_at)) AS d FROM issues WHERE status='resolved'`),
  allTags: db.prepare(`SELECT tags FROM issues WHERE tags != '[]' AND tags != ''`),
  // custom categories
  insertCustomCat: db.prepare(`INSERT OR IGNORE INTO custom_categories (slug, label) VALUES (?,?)`),
  allCustomCats: db.prepare(`SELECT slug, label FROM custom_categories ORDER BY created_at`),
  deleteCustomCat: db.prepare(`DELETE FROM custom_categories WHERE slug = ?`),
  // admin responses
  insertAdminResponse: db.prepare(`INSERT INTO admin_responses (issue_id, response, admin_name, is_public) VALUES (?,?,?,?)`),
  adminResponsesByIssue: db.prepare(`SELECT id, response, admin_name, is_public, created_at FROM admin_responses WHERE issue_id = ? ORDER BY id`),
  publicResponsesByIssue: db.prepare(`SELECT id, response, admin_name, created_at FROM admin_responses WHERE issue_id = ? AND is_public = 1 ORDER BY id`),
  deleteAdminResponse: db.prepare(`DELETE FROM admin_responses WHERE id = ?`),
};

function makeCode() {
  return 'SKA-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// Sanitize tags: array of short lowercase strings, max 5 tags, max 24 chars each
function cleanTags(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((t) => String(t).trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24)).filter(Boolean))].slice(0, 5);
}

// Public view never leaks the author when anonymous.
function publicIssue(row, withTimeline = false, withReplies = false, withAdminResponses = false) {
  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch {}
  const replyCount = q.replyCount.get(row.id)?.n ?? 0;
  const CATS = getCategories();
  const out = {
    code: row.code,
    title: row.title,
    description: row.description,
    category: row.category,
    team: row.team || CATS[row.category] || row.category,
    status: row.status,
    upvotes: row.upvotes,
    downvotes: row.downvotes ?? 0,
    tags,
    reply_count: replyCount,
    created_at: row.created_at,
    updated_at: row.updated_at,
    author: row.anonymous ? 'Anonymous' : row.author || 'Student',
  };
  if (withTimeline) out.timeline = q.timeline.all(row.id);
  if (withReplies) {
    out.replies = q.repliesByIssue.all(row.id).map((r) => ({
      id: r.id,
      author: r.anonymous ? 'Anonymous' : r.author,
      content: r.content,
      created_at: r.created_at,
    }));
  }
  if (withAdminResponses) {
    out.admin_responses = q.publicResponsesByIssue.all(row.id);
  }
  return out;
}

// ---------- helpers ----------
const sessions = new Set(); // admin tokens (in-memory)
const rate = new Map(); // ip -> {count, reset}

function rateLimited(ip, limit = 10, windowMs = 60_000) {
  const now = Date.now();
  const r = rate.get(ip);
  if (!r || now > r.reset) { rate.set(ip, { count: 1, reset: now + windowMs }); return false; }
  r.count++;
  return r.count > limit;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 20_000) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
  });
}

function isAdmin(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  return sessions.has(t);
}

const clean = (s, max) => String(s || '').trim().slice(0, max);

// ---------- routes ----------
async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress;
  const p = url.pathname;

  // GET /api/meta
  if (req.method === 'GET' && p === '/api/meta') {
    const tagSet = new Set();
    for (const row of q.allTags.all()) {
      try { for (const t of JSON.parse(row.tags)) tagSet.add(t); } catch {}
    }
    const categories = getCategories();
    return send(res, 200, { categories, statuses: STATUSES, popularTags: [...tagSet].slice(0, 30) });
  }

  // GET /api/stats
  if (req.method === 'GET' && p === '/api/stats') {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of q.stats.all()) counts[r.status] = r.n;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const d = q.avgResolve.get().d;
    return send(res, 200, { total, ...counts, avg_days_to_resolve: d != null ? Number(d.toFixed(1)) : null });
  }

  // GET /api/issues?category=&status=&sort=recent|votes|controversial&search=&tag=
  if (req.method === 'GET' && p === '/api/issues') {
    const where = [], args = [];
    const cat = url.searchParams.get('category');
    const st = url.searchParams.get('status');
    const s = url.searchParams.get('search');
    const tag = url.searchParams.get('tag');
    const CATS = getCategories();
    if (cat && CATS[cat]) { where.push('category = ?'); args.push(cat); }
    if (st && STATUSES.includes(st)) { where.push('status = ?'); args.push(st); }
    if (s) { where.push('(title LIKE ? OR description LIKE ?)'); args.push(`%${s}%`, `%${s}%`); }
    if (tag) { where.push(`tags LIKE ?`); args.push(`%"${tag}"%`); }
    const sortMap = { votes: 'upvotes DESC, id DESC', controversial: '(upvotes + downvotes) DESC, id DESC', recent: 'id DESC' };
    const order = sortMap[url.searchParams.get('sort')] || 'id DESC';
    const rows = db.prepare(`SELECT * FROM issues ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 100`).all(...args);
    return send(res, 200, rows.map((r) => publicIssue(r)));
  }

  // POST /api/issues  — anonymous by default
  if (req.method === 'POST' && p === '/api/issues') {
    if (rateLimited(ip, 5)) return send(res, 429, { error: 'Too many reports. Try again in a minute.' });
    const b = await readBody(req);
    const title = clean(b.title, 120);
    const description = clean(b.description, 2000);
    const CATS = getCategories();
    let categorySlug = null;
    // Support custom category submission by students
    if (b.category && CATS[b.category]) {
      categorySlug = b.category;
    } else if (b.customCategory) {
      // Student creates a new custom category on the fly
      const rawLabel = clean(b.customCategory, 60);
      if (rawLabel.length < 2) return send(res, 400, { error: 'Custom category name too short.' });
      const slug = 'custom_' + rawLabel.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 30);
      q.insertCustomCat.run(slug, rawLabel);
      categorySlug = slug;
    }
    if (!categorySlug) return send(res, 400, { error: 'Pick a valid category or enter a custom one.' });
    const CATS2 = getCategories();
    const teamLabel = CATS2[categorySlug] || categorySlug;
    if (title.length < 5) return send(res, 400, { error: 'Title must be at least 5 characters.' });
    if (description.length < 15) return send(res, 400, { error: 'Please describe the issue in at least 15 characters.' });
    const anonymous = b.anonymous === false ? 0 : 1;
    const author = anonymous ? null : clean(b.author, 60) || 'Student';
    const tags = JSON.stringify(cleanTags(b.tags));

    let code = makeCode();
    while (q.byCode.get(code)) code = makeCode();
    const info = q.insertIssue.run(code, title, description, categorySlug, teamLabel, anonymous, author, tags);
    q.insertTimeline.run(info.lastInsertRowid, 'submitted', `Routed to ${teamLabel}.`);
    return send(res, 201, { code, message: 'Issue submitted. Save this code to track it.' });
  }

  // GET /api/issues/:code
  let m = p.match(/^\/api\/issues\/(SKA-[0-9A-F]{6})$/i);
  if (m && req.method === 'GET') {
    const row = q.byCode.get(m[1].toUpperCase());
    if (!row) return send(res, 404, { error: 'No issue found with that code.' });
    return send(res, 200, publicIssue(row, true, true, true));
  }

  // POST /api/issues/:code/vote  { voter, type: 'up'|'down' } — toggleable
  m = p.match(/^\/api\/issues\/(SKA-[0-9A-F]{6})\/vote$/i);
  if (m && req.method === 'POST') {
    const b = await readBody(req);
    const voter = clean(b.voter, 64);
    const type = b.type === 'down' ? 'down' : 'up';
    if (!voter) return send(res, 400, { error: 'Missing voter id.' });
    const row = q.byCode.get(m[1].toUpperCase());
    if (!row) return send(res, 404, { error: 'Issue not found.' });
    const existing = q.getVote.get(row.id, voter);
    if (!existing) {
      q.addVote.run(row.id, voter, type);
      if (type === 'up') q.bumpUp.run(row.id); else q.bumpDown.run(row.id);
    } else if (existing.vote_type === type) {
      q.removeVote.run(row.id, voter);
      if (type === 'up') q.unbumpUp.run(row.id); else q.unbumpDown.run(row.id);
    } else {
      q.updateVote.run(type, row.id, voter);
      if (type === 'up') { q.bumpUp.run(row.id); q.unbumpDown.run(row.id); }
      else { q.bumpDown.run(row.id); q.unbumpUp.run(row.id); }
    }
    const updated = q.byId.get(row.id);
    const currentVote = q.getVote.get(row.id, voter);
    return send(res, 200, { upvotes: updated.upvotes, downvotes: updated.downvotes, userVote: currentVote?.vote_type || null });
  }

  // GET /api/issues/:code/replies
  m = p.match(/^\/api\/issues\/(SKA-[0-9A-F]{6})\/replies$/i);
  if (m && req.method === 'GET') {
    const row = q.byCode.get(m[1].toUpperCase());
    if (!row) return send(res, 404, { error: 'Issue not found.' });
    const replies = q.repliesByIssue.all(row.id).map((r) => ({
      id: r.id,
      author: r.anonymous ? 'Anonymous' : r.author,
      content: r.content,
      created_at: r.created_at,
    }));
    return send(res, 200, replies);
  }

  // POST /api/issues/:code/replies  { content, author?, anonymous? }
  m = p.match(/^\/api\/issues\/(SKA-[0-9A-F]{6})\/replies$/i);
  if (m && req.method === 'POST') {
    if (rateLimited(ip, 20)) return send(res, 429, { error: 'Too many replies. Slow down.' });
    const b = await readBody(req);
    const row = q.byCode.get(m[1].toUpperCase());
    if (!row) return send(res, 404, { error: 'Issue not found.' });
    const content = clean(b.content, 500);
    if (content.length < 2) return send(res, 400, { error: 'Reply too short.' });
    const anonymous = b.anonymous === false ? 0 : 1;
    const author = anonymous ? 'Anonymous' : (clean(b.author, 60) || 'Student');
    q.insertReply.run(row.id, author, content, anonymous);
    return send(res, 201, { ok: true });
  }

  // POST /api/admin/login
  if (req.method === 'POST' && p === '/api/admin/login') {
    if (rateLimited(ip, 5)) return send(res, 429, { error: 'Too many attempts.' });
    const b = await readBody(req);
    const a = Buffer.from(String(b.password || ''));
    const e = Buffer.from(ADMIN_PASSWORD);
    const ok = a.length === e.length && crypto.timingSafeEqual(a, e);
    if (!ok) return send(res, 401, { error: 'Wrong password.' });
    const token = crypto.randomBytes(24).toString('hex');
    sessions.add(token);
    return send(res, 200, { token });
  }

  // PATCH /api/admin/issues/:code  { status, note }
  m = p.match(/^\/api\/admin\/issues\/(SKA-[0-9A-F]{6})$/i);
  if (m && req.method === 'PATCH') {
    if (!isAdmin(req)) return send(res, 401, { error: 'Admin login required.' });
    const b = await readBody(req);
    if (!STATUSES.includes(b.status)) return send(res, 400, { error: 'Invalid status.' });
    const row = q.byCode.get(m[1].toUpperCase());
    if (!row) return send(res, 404, { error: 'Issue not found.' });
    q.setStatus.run(b.status, row.id);
    q.insertTimeline.run(row.id, b.status, clean(b.note, 300) || null);
    return send(res, 200, publicIssue(q.byId.get(row.id), true));
  }

  // POST /api/admin/issues/:code/respond  { response, admin_name?, is_public? }
  m = p.match(/^\/api\/admin\/issues\/(SKA-[0-9A-F]{6})\/respond$/i);
  if (m && req.method === 'POST') {
    if (!isAdmin(req)) return send(res, 401, { error: 'Admin login required.' });
    const b = await readBody(req);
    const row = q.byCode.get(m[1].toUpperCase());
    if (!row) return send(res, 404, { error: 'Issue not found.' });
    const response = clean(b.response, 1000);
    if (response.length < 5) return send(res, 400, { error: 'Response too short.' });
    const adminName = clean(b.admin_name, 60) || 'Admin';
    const isPublic = b.is_public === false ? 0 : 1;
    q.insertAdminResponse.run(row.id, response, adminName, isPublic);
    const all = q.adminResponsesByIssue.all(row.id);
    return send(res, 201, { ok: true, responses: all });
  }

  // DELETE /api/admin/issues/:code/respond/:id
  m = p.match(/^\/api\/admin\/issues\/(SKA-[0-9A-F]{6})\/respond\/(\d+)$/i);
  if (m && req.method === 'DELETE') {
    if (!isAdmin(req)) return send(res, 401, { error: 'Admin login required.' });
    q.deleteAdminResponse.run(Number(m[2]));
    return send(res, 200, { ok: true });
  }

  // GET /api/admin/issues/:code  (full data incl. private responses)
  m = p.match(/^\/api\/admin\/issues\/(SKA-[0-9A-F]{6})$/i);
  if (m && req.method === 'GET') {
    if (!isAdmin(req)) return send(res, 401, { error: 'Admin login required.' });
    const row = q.byCode.get(m[1].toUpperCase());
    if (!row) return send(res, 404, { error: 'Issue not found.' });
    const issue = publicIssue(row, true, true);
    issue.admin_responses = q.adminResponsesByIssue.all(row.id);
    return send(res, 200, issue);
  }

  // GET /api/admin/custom-categories
  if (req.method === 'GET' && p === '/api/admin/custom-categories') {
    if (!isAdmin(req)) return send(res, 401, { error: 'Admin login required.' });
    return send(res, 200, q.allCustomCats.all());
  }

  // DELETE /api/admin/custom-categories/:slug
  m = p.match(/^\/api\/admin\/custom-categories\/([a-z0-9_-]+)$/i);
  if (m && req.method === 'DELETE') {
    if (!isAdmin(req)) return send(res, 401, { error: 'Admin login required.' });
    if (BUILTIN_CATEGORIES[m[1]]) return send(res, 400, { error: 'Cannot delete a built-in category.' });
    q.deleteCustomCat.run(m[1]);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found.' });
}

// ---------- static ----------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}).listen(PORT, () => console.log(`Shankra ki Awazz running → http://localhost:${PORT}`));
