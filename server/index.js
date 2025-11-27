import express from 'express';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import cors from 'cors';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// --- API ROUTES ---

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Runner Service listening at http://0.0.0.0:${PORT}`);
  console.log(`Scanning for games in: ${DATA_DIR}`);
});