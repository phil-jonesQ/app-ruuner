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
  // We explicitly use npm ci if lockfile exists, or install.
  // Then run build.
  const command = `cd "${projectPath}" && npm install && npm run build`;

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

    // Serve static files from the dist folder
    express.static(appDistPath)(req, res, next);
});

// Catch-all for the Runner UI (client-side routing support)
app.get('*', (req, res) => {
  if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  } else {
    res.send('Runner UI building...');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Runner Service listening at http://0.0.0.0:${PORT}`);
  console.log(`Scanning for games in: ${DATA_DIR}`);
});