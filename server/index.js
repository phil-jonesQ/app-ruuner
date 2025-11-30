import express from 'express';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import cors from 'cors';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import http from 'http';
import { Server as SocketIO } from 'socket.io';
import Database from 'better-sqlite3';

const app = express();
const PORT = process.env.PORT || 2001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data_mock'); // Fallback for local dev

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) {
  console.log(`Creating data directory at ${DATA_DIR}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());

// Serve the compiled Runner UI from the dist folder (located one level up in Docker)
const DIST_DIR = path.join(__dirname, '../dist');

// IMPORTANT: If this service is deployed behind a reverse proxy which strips a mount
// prefix (for example nginx proxying /games/ -> upstream /), the request path will
// look like '/' to the server but the proxy should set X-Forwarded-Prefix so the
// upstream can still rewrite absolute asset paths in index.html to the mounted prefix.
//
// express.static will otherwise serve the unmodified index.html for '/', bypassing the
// catch-all rewrite handler below. To ensure proxied-root requests are rewritten we
// intercept GET / or GET /index.html requests that include X-Forwarded-Prefix and
// serve a rewritten index.html before express.static takes over.
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '' || req.path === '/index.html')) {
    const forwardedPrefix = (req.headers['x-forwarded-prefix'] || '').toString();
    if (forwardedPrefix) {
      const indexFile = path.join(DIST_DIR, 'index.html');
      if (fs.existsSync(indexFile)) {
        let html = fs.readFileSync(indexFile, 'utf8');

        let mountPrefix = forwardedPrefix.endsWith('/') ? forwardedPrefix : forwardedPrefix + '/';

        // add <base> tag if missing
        if (!/\<base\s+href=/.test(html)) {
          html = html.replace(/<head([^>]*)>/i, `<head$1>\n    <base href="${mountPrefix}">`);
        }

        // rewrite common absolute asset paths
        html = html.replace(/(src|href)=(['"])\/assets\//g, `$1=$2${mountPrefix}assets/`);
        html = html.replace(/(src|href)=(['"])\/(favicon|manifest|robots|logo|apple-touch-icon)/g, `$1=$2${mountPrefix}$3`);

        // generic safe rewrite for absolute paths which aren't external
        const safeNegatives = ['/', 'https?:', '#', 'mailto:', 'tel:'];
        const prefixToken = mountPrefix.replace(/^\//, '').replace(/\/$/, '');
        if (prefixToken) safeNegatives.push(prefixToken);
        const negLook = safeNegatives.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const genericRe = new RegExp(`(src|href)=(["'])\\/(?!${negLook})([^\"'>\\s]*)`, 'g');
        html = html.replace(genericRe, (m, attr, quote, rest) => `${attr}=${quote}${mountPrefix}${rest}`);

        // srcset support
        html = html.replace(/srcset=(["'])(.*?)\1/g, (m, q, val) => {
          const newVal = val.split(',').map(part => {
            let sub = part.trim();
            const parts = sub.split(/\s+/);
            const url = parts[0] || '';
            if (url.startsWith('/') && !url.startsWith('//') && !url.startsWith(mountPrefix) && !/^https?:\/\//.test(url)) {
              parts[0] = mountPrefix + url.slice(1);
            }
            return parts.join(' ');
          }).join(', ');
          return `srcset=${q}${newVal}${q}`;
        });

        return res.type('html').send(html);
      }
    }
  }
  next();
});

app.use(express.static(DIST_DIR));

// --- SQLite persistence (server/state.db)
const DB_FILE = path.join(__dirname, 'state.db');
let db;
try {
  db = new Database(DB_FILE);
} catch (e) {
  console.error('Failed to open SQLite DB', e.message);
  process.exit(1);
}

// Initialize schema
db.exec(`
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS launches (project_id TEXT PRIMARY KEY, count INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS ratings (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, rating INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, meta TEXT, connected_at TEXT DEFAULT CURRENT_TIMESTAMP, disconnected_at TEXT DEFAULT NULL);
`);

// If existing state.json exists, migrate to sqlite (one-time)
try {
  const sfile = path.join(__dirname, 'state.json');
  if (fs.existsSync(sfile)) {
    try {
      const raw = fs.readFileSync(sfile, 'utf8');
      const parsed = JSON.parse(raw);

      const insertKV = db.prepare('INSERT OR REPLACE INTO kv (k,v) VALUES (?,?)');
      if (parsed.version) insertKV.run('version', parsed.version);

      const insertLaunch = db.prepare('INSERT OR REPLACE INTO launches (project_id, count) VALUES (?,?)');
      for (const [k,v] of Object.entries(parsed.launches || {})) insertLaunch.run(k, Number(v || 0));

      const insertRating = db.prepare('INSERT INTO ratings (project_id,rating) VALUES (?,?)');
      for (const [k, arr] of Object.entries(parsed.ratings || {})) {
        if (Array.isArray(arr)) for (const r of arr) insertRating.run(k, Number(r));
      }

      // remove old state.json to avoid re-migration
      try { fs.unlinkSync(sfile); } catch (e) {}
    } catch (e) {
      console.warn('Failed to migrate state.json', e.message);
    }
  }
} catch (e) {}

// helper getters
const getVersionKV = db.prepare('SELECT v FROM kv WHERE k = ?');
const setVersionKV = db.prepare('INSERT OR REPLACE INTO kv (k,v) VALUES (?,?)');
const getLaunch = db.prepare('SELECT count FROM launches WHERE project_id = ?');
const incLaunch = db.prepare('INSERT INTO launches(project_id,count) VALUES(?,1) ON CONFLICT(project_id) DO UPDATE SET count = count + 1');
const setLaunch = db.prepare('INSERT OR REPLACE INTO launches (project_id, count) VALUES (?,?)');
const getAllLaunches = db.prepare('SELECT project_id, count FROM launches');
const insertRating = db.prepare('INSERT INTO ratings (project_id, rating) VALUES (?,?)');
const getRatingSummary = db.prepare('SELECT project_id, COUNT(*) as count, AVG(rating) as average FROM ratings GROUP BY project_id');
const createSession = db.prepare('INSERT OR REPLACE INTO sessions (id, meta, connected_at, disconnected_at) VALUES (?, ?, CURRENT_TIMESTAMP, NULL)');
const disconnectSession = db.prepare('UPDATE sessions SET disconnected_at = CURRENT_TIMESTAMP WHERE id = ?');
const countOnlineSessions = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE disconnected_at IS NULL");

// Runtime-only track of connected clients (sessions)
let runtimeOnline = 0;

// --- API ROUTES ---

// Support requests that arrive under a proxy-mounted prefix like /games/*
// If the incoming path contains '/api/' but isn't mounted at root, rewrite req.url
// so our handlers (which are registered at /api/*) still match.
app.use((req, res, next) => {
  try {
    const idx = req.path.indexOf('/api/');
    if (idx > 0) {
      // rewrite URL so next handlers see '/api/...'
      req.url = req.url.substring(idx);
    }
  } catch(e) {}
  next();
});

// 1. List all projects in the data directory
app.get('/api/projects', (req, res) => {
  try {
    const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
    
    const projects = entries
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const projectPath = path.join(DATA_DIR, entry.name);
        const distPath = path.join(projectPath, 'dist');
        const packageJsonPath = path.join(projectPath, 'package.json');
        
        let meta = { name: entry.name, description: 'No description' };
        
        // Try to read metadata.json or package.json
        if (fs.existsSync(path.join(projectPath, 'metadata.json'))) {
             try {
                const m = JSON.parse(fs.readFileSync(path.join(projectPath, 'metadata.json'), 'utf-8'));
                if (m.name) meta.name = m.name;
                if (m.description) meta.description = m.description;
             } catch (e) {}
        } else if (fs.existsSync(packageJsonPath)) {
            try {
                const p = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
                if (p.description) meta.description = p.description;
            } catch (e) {}
        }

        return {
          id: entry.name,
          name: meta.name,
          description: meta.description,
          hasDist: fs.existsSync(distPath),
          hasPackageJson: fs.existsSync(packageJsonPath),
          path: `/apps/${entry.name}/`
        };
      });

    res.json(projects);
  } catch (error) {
    console.error("Error reading projects:", error);
    res.status(500).json({ error: "Failed to scan projects" });
  }
});

// --- Stats + persistence endpoints ---
app.get('/api/stats', (req, res) => {
  try {
    const versionRow = getVersionKV.get('version');
    const version = versionRow ? versionRow.v : '1.0.1';

    // launches
    const launches = {};
    for (const row of getAllLaunches.all()) launches[row.project_id] = Number(row.count || 0);

    // ratings summary
    const ratings = {};
    for (const row of getRatingSummary.all()) {
      ratings[row.project_id] = { average: Number(row.average || 0), count: Number(row.count || 0) };
    }

    // sessions online (use DB authoritative count)
    const c = countOnlineSessions.get();
    const online = c ? Number(c.c || 0) : 0;

    return res.json({ version, online, launches, ratings });
  } catch (e) {
    console.error('Failed to build stats response', e.message);
    res.status(500).json({ error: 'Failed to build stats' });
  }
});

// Debug: list recent sessions (connected/disconnected)
app.get('/api/sessions', (req, res) => {
  try {
    const rows = db.prepare('SELECT id, meta, connected_at, disconnected_at FROM sessions ORDER BY connected_at DESC LIMIT 200').all();
    return res.json(rows.map(r => ({ id: r.id, meta: r.meta ? JSON.parse(r.meta) : null, connected_at: r.connected_at, disconnected_at: r.disconnected_at })));
  } catch (e) {
    console.warn('Failed to read sessions', e.message);
    res.status(500).json({ error: 'Failed to read sessions' });
  }
});

// increment a project's launch counter
app.post('/api/launch/:id', (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'Invalid id' });

    incLaunch.run(id);
    const newValRow = getLaunch.get(id);
    const launches = newValRow ? Number(newValRow.count || 0) : 0;

    // notify connected clients
    try { app.emit('stats-changed', { type: 'launch', id, launches }); } catch (e) {}

    return res.json({ success: true, launches });
  } catch (e) {
    console.error('Failed to record launch', e.message);
    res.status(500).json({ error: 'Failed to record launch' });
  }
});

// record a rating (expected body: { rating: number })
app.post('/api/rate/:id', (req, res) => {
  try {
    const id = req.params.id;
    const rating = Number(req.body?.rating);
    if (!id || Number.isNaN(rating) || rating < 0 || rating > 5) return res.status(400).json({ error: 'Invalid payload' });

    insertRating.run(id, rating);

    // compute count for this project
    const summary = db.prepare('SELECT COUNT(*) as c FROM ratings WHERE project_id = ?').get(id);
    const count = summary ? Number(summary.c || 0) : 0;

    // emit
    try { app.emit('stats-changed', { type: 'rating', id, rating }); } catch (e) {}

    return res.json({ success: true, ratingCount: count });
  } catch (e) {
    console.error('Failed to record rating', e.message);
    res.status(500).json({ error: 'Failed to rate' });
  }
});

// 2. Build a project
app.post('/api/build/:id', (req, res) => {
  const projectId = req.params.id;
  const projectPath = path.join(DATA_DIR, projectId);

  if (!fs.existsSync(projectPath)) {
    return res.status(404).json({ error: "Project not found" });
  }

  // Safety check: Don't allow running commands outside DATA_DIR
  if (projectId.includes('..') || projectId.includes('/')) {
     return res.status(400).json({ error: "Invalid project ID" });
  }

  console.log(`Starting build for ${projectId}...`);

  // Command to install and build.
  // Several projects (vite etc) live in devDependencies. Some environments
  // (NODE_ENV=production) cause plain `npm install` to skip devDependencies
  // which results in `vite: not found` when running `npm run build`.
  //
  // To be resilient we:
  // - prefer `npm ci --include=dev` when lockfile exists
  // - otherwise run `npm install --include=dev`
  // This ensures devDependencies (like vite) are installed and the build works
  // even when NODE_ENV is set to production on the host/container.
  const useCi = fs.existsSync(path.join(projectPath, 'package-lock.json')) || fs.existsSync(path.join(projectPath, 'npm-shrinkwrap.json'));
  const installCmd = useCi ? 'npm ci --include=dev' : 'npm install --include=dev';
  const command = `cd "${projectPath}" && ${installCmd} && npm run build`;

  exec(command, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`Build error for ${projectId}:`, stderr);
      return res.status(500).json({ 
        error: "Build failed", 
        details: stderr || error.message 
      });
    }
    console.log(`Build success for ${projectId}`);
    res.json({ success: true, logs: stdout });
  });
});

// --- DYNAMIC APP SERVING ---

// Serve static files for each app inside /data
// Route: /apps/:appId/*
// NOTE: Many Vite-built projects use absolute "/assets/..." paths which break when
// the app is mounted under a subpath (e.g. /apps/:appId). To support that without
// forcing rebuilds, we detect requests for the app root or index.html and serve a
// rewritten index.html that points asset paths to the /apps/:appId/ prefix.
app.use('/apps/:appId', (req, res, next) => {
    const appId = req.params.appId;
    
    // Safety
    if (appId.includes('..')) return res.status(403).send("Forbidden");

    const appDistPath = path.join(DATA_DIR, appId, 'dist');

    if (!fs.existsSync(appDistPath)) {
        return res.status(404).send(`
            <html>
                <body style="background:#111; color:white; font-family:sans-serif; display:flex; justify-content:center; align-items:center; height:100vh;">
                    <div style="text-align:center">
                        <h1>App Not Built</h1>
                        <p>This application hasn't been built yet.</p>
                        <p>Go back to the Dashboard and click "Build".</p>
                        <a href="/" style="color:#60a5fa">Return to Dashboard</a>
                    </div>
                </body>
            </html>
        `);
    }

    // If the request looks like the SPA root (no file extension, or explicit index.html),
    // read and rewrite the index.html so absolute asset paths are redirected under the
    // mounted subpath (/apps/:appId/). This lets the app work even if it was built
    // with the default Vite base ('/') behavior.
    const reqPath = req.path || '';

    const looksLikeIndex = reqPath === '/' || reqPath === '' || reqPath === '/index.html' || !path.basename(reqPath).includes('.');

    if (req.method === 'GET' && looksLikeIndex) {
      const indexFile = path.join(appDistPath, 'index.html');
      if (fs.existsSync(indexFile)) {
        let html = fs.readFileSync(indexFile, 'utf8');

        // ensure we add a base tag so relative links work; base only helps relative urls
        // Respect proxies that set X-Forwarded-Prefix so when the app runner
        // is mounted under a path (e.g. /games/) the asset paths resolve to
        // /games/apps/<id>/ instead of /apps/<id>/ (which would be wrong).
        const forwardedPrefix = (req.headers['x-forwarded-prefix'] || '').toString();
        let baseHref = `/apps/${appId}/`;
        if (forwardedPrefix) {
          // normalize prefix to start and end with single slash
          let prefix = forwardedPrefix;
          if (!prefix.startsWith('/')) prefix = '/' + prefix;
          if (!prefix.endsWith('/')) prefix = prefix + '/';
          baseHref = `${prefix}apps/${appId}/`;
        }
        if (/\<base\s+href=/.test(html)) {
          // If the app already includes a base tag (common when the app was
          // built with a base), update it to include the mounted proxy prefix
          // when present so assets resolve under the mounted path.
          if (forwardedPrefix) {
            html = html.replace(/(<base\s+href=)(["'])([^"']*)(\2)/i, `$1$2${baseHref}$4`);
          }
        } else {
          html = html.replace(/<head([^>]*)>/i, `<head$1>\n    <base href="${baseHref}">`);
        }

        // rewrite absolute asset paths like src="/assets/..." to point under the
        // computed baseHref (which may include a forwarded prefix when behind a proxy)
        html = html.replace(/(src|href)=(['"])\/assets\//g, `$1=$2${baseHref}assets/`);
        // common static root files (favicon, manifest, robots)
        html = html.replace(/(src|href)=(['"])\/(favicon|manifest|robots|logo|apple-touch-icon)/g, `$1=$2${baseHref}$3`);

        // If the built html includes absolute /apps/<id>/ references (some builds
        // do this) we must rewrite those to the mounted prefix. For example,
        // /apps/heavy-artillery-sim/assets/... -> /games/apps/heavy-artillery-sim/assets/...
        const appAbsRe = new RegExp(`(src|href)=(["'])\/apps\/${appId}\/(.*?)`, 'g');
        html = html.replace(appAbsRe, (m, attr, quote, rest) => `${attr}=${quote}${baseHref}${rest}`);

        // MORE ROBUST: rewrite any absolute src/href that begins with "/" and
        // is NOT an external URL (http://, https:// or protocol-relative //).
        html = html.replace(/(src|href)=(["'])\/(?!\/|https?:)([^"'>\s]*)/g, (m, attr, quote, rest) => {
          // Avoid accidentally rewriting paths that already begin with the base
          // (for example if they were rewritten above)
          if (rest.startsWith(baseHref.replace(/^\//, ''))) return m;
          return `${attr}=${quote}${baseHref}${rest}`;
        });

        // Handle srcset attributes which contain a list of comma-separated URLs
        // possibly with descriptors. We rewrite any listed URL that begins with
        // a single leading slash and is not external or /apps/.
        html = html.replace(/srcset=(["'])(.*?)\1/g, (m, q, val) => {
          const newVal = val.split(',').map(part => {
            let sub = part.trim();
            const parts = sub.split(/\s+/);
            const url = parts[0] || '';
            if (url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/apps') && !/^https?:\/\//.test(url)) {
              // join with base href (drop the leading slash)
              parts[0] = baseHref + url.slice(1);
            }
            return parts.join(' ');
          }).join(', ');
          return `srcset=${q}${newVal}${q}`;
        });

        res.type('html').send(html);
        return;
      }
    }

    // Serve static files from the dist folder
    express.static(appDistPath)(req, res, next);
});

// Catch-all for the Runner UI (client-side routing support)
app.get('*', (req, res) => {
  const indexPath = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    // If the app is being served behind a reverse proxy at a prefix, the
    // proxy should ideally set a header like X-Forwarded-Prefix (e.g. /games/).
    // When present, we rewrite index.html so absolute assets ("/assets/...") and
    // other root-bound URLs are adjusted to load from the mounted prefix.
    const forwardedPrefix = (req.headers['x-forwarded-prefix'] || '').toString();
    // Also support the case where nginx proxied a path such as /games by sending
    // the request through unchanged (the server will receive the path /games).
    // If the request path is not root, guess the mount point (only take the first segment).
    // E.g. /games/whatever -> '/games/'
    let mountPrefix = '/';
    if (forwardedPrefix) mountPrefix = forwardedPrefix.endsWith('/') ? forwardedPrefix : forwardedPrefix + '/';
    else if (req.path && req.path !== '/' && req.path !== '') {
      // Take the first path segment as the likely mount prefix if the path looks root-ish
      const parts = req.path.split('/').filter(Boolean);
      if (parts.length > 0) mountPrefix = `/${parts[0]}/`;
    }

    // If mountPrefix is simply '/' then send the unmodified index file.
    if (mountPrefix === '/') {
      return res.sendFile(indexPath);
    }

    // Otherwise load and rewrite index.html similar to the /apps/:id handler so
    // absolute assets and root files are adjusted to the mounted prefix.
    let html = fs.readFileSync(indexPath, 'utf8');
    if (!/\<base\s+href=/.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>\n    <base href="${mountPrefix}">`);
    }

    // Rewrite absolute asset hrefs beginning with /assets or root files to the mount prefix
    html = html.replace(/(src|href)=(['"])\/assets\//g, `$1=$2${mountPrefix}assets/`);
    html = html.replace(/(src|href)=(['"])\/(favicon|manifest|robots|logo|apple-touch-icon)/g, `$1=$2${mountPrefix}$3`);

    // Generic safe rewrite for absolute paths that are not external URLs and not already for the mount.
    // Build the regex dynamically so the current mountPrefix is correctly escaped/used.
    const prefixToken = mountPrefix.replace(/^\//, '').replace(/\/$/, '');
    const safeNegatives = ['/', 'https?:', '#', 'mailto:', 'tel:'];
    if (prefixToken) safeNegatives.push(prefixToken);
    // escape alternation pieces for use in a RegExp
    const negLook = safeNegatives.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const genericRe = new RegExp(`(src|href)=(["'])\\/(?!${negLook})([^\"'>\\s]*)`, 'g');
    html = html.replace(genericRe, (m, attr, quote, rest) => `${attr}=${quote}${mountPrefix}${rest}`);

    // srcset support for absolute urls
    html = html.replace(/srcset=(["'])(.*?)\1/g, (m, q, val) => {
      const newVal = val.split(',').map(part => {
        let sub = part.trim();
        const parts = sub.split(/\s+/);
        const url = parts[0] || '';
        if (url.startsWith('/') && !url.startsWith('//') && !url.startsWith(mountPrefix) && !/^https?:\/\//.test(url)) {
          parts[0] = mountPrefix + url.slice(1);
        }
        return parts.join(' ');
      }).join(', ');
      return `srcset=${q}${newVal}${q}`;
    });

    return res.type('html').send(html);
  } else {
    res.send('Runner UI building...');
  }
});

// create an http server and attach socket.io so we can track sessions
const server = http.createServer(app);

// If the app is mounted behind a proxy (for example /games/), websocket
// upgrade requests may come in with paths like '/games/socket.io/...'.
// Rewrite those upgrade request URLs so engine/socket.io sees the expected
// '/socket.io' path and can accept the connection.
server.on('upgrade', (req, socket, head) => {
  try {
    const u = req.url || '';
    const idx = u.indexOf('/socket.io');
    if (idx > 0) {
      // rewrite to start at /socket.io
      req.url = u.substring(idx);
    }
  } catch (e) {}
});

// Also rewrite plain HTTP requests for socket.io polling when the proxy keeps
// a mount prefix (e.g. '/games/socket.io/...') so engine.io's handlers see the
// expected '/socket.io' path.
server.on('request', (req, res) => {
  try {
    const u = req.url || '';
    const idx = u.indexOf('/socket.io');
    if (idx > 0) {
      req.url = u.substring(idx);
    }
  } catch (e) {}
});

const io = new SocketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  // persist session to DB on connect
  try {
    createSession.run(socket.id, null);
  } catch (e) {}

  // compute current online count from DB and broadcast
  try {
    const c = countOnlineSessions.get();
    runtimeOnline = c ? Number(c.c || 0) : io.sockets.sockets.size;
    io.emit('session:update', { online: runtimeOnline });
  } catch (e) {
    runtimeOnline = io.sockets.sockets.size;
    io.emit('session:update', { online: runtimeOnline });
  }

  // send the current persisted stats to the newly connected socket
  try {
    const versionRow = getVersionKV.get('version');
    const version = versionRow ? versionRow.v : '1.0.1';

    const launches = {};
    for (const row of getAllLaunches.all()) launches[row.project_id] = Number(row.count || 0);

    const ratings = Object.fromEntries(getRatingSummary.all().map(r => [r.project_id, { average: Number(r.average || 0), count: Number(r.count || 0) }]));

    socket.emit('stats:update', { stats: { version, online: runtimeOnline, launches, ratings } });
  } catch (e) {
    // ignore
  }

  // optional: client may send a join event (we persist meta)
  socket.on('session:join', (meta) => {
    try { createSession.run(socket.id, JSON.stringify(meta || null)); } catch (e) {}
    io.emit('session:joined', { id: socket.id, meta, online: io.sockets.sockets.size });
  });

  socket.on('disconnect', () => {
    try { disconnectSession.run(socket.id); } catch (e) {}
    try {
      const c = countOnlineSessions.get();
      runtimeOnline = c ? Number(c.c || 0) : io.sockets.sockets.size;
      io.emit('session:update', { online: runtimeOnline });
    } catch (e) {
      runtimeOnline = io.sockets.sockets.size;
      io.emit('session:update', { online: runtimeOnline });
    }
  });
});

// When our API updates persisted stats, forward those changes via socket so UIs stay in sync
app.on('stats-changed', (payload) => {
  try {
    const versionRow = getVersionKV.get('version');
    const version = versionRow ? versionRow.v : '1.0.1';

    const launches = {};
    for (const row of getAllLaunches.all()) launches[row.project_id] = Number(row.count || 0);

    const ratings = Object.fromEntries(getRatingSummary.all().map(r => [r.project_id, { average: Number(r.average || 0), count: Number(r.count || 0) }]));

    io.emit('stats:update', { payload, stats: { version, online: runtimeOnline, launches, ratings } });
  } catch (e) {
    console.warn('Failed to emit stats-changed', e.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Runner Service listening at http://0.0.0.0:${PORT}`);
  console.log(`Scanning for games in: ${DATA_DIR}`);
});