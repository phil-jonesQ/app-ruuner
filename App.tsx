import { useState, useEffect, useRef } from 'react';
import { Terminal, Play, Loader2, RefreshCw, AlertTriangle, Hammer, ExternalLink } from 'lucide-react';
import { Project } from './types';

const App = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState<number>(0);
  const [version, setVersion] = useState<string>('1.0.1');
  const [stats, setStats] = useState<any>({ launches: {}, ratings: {} });
  const [hoverRating, setHoverRating] = useState<Record<string, number>>({});
  const [ratingSubmitting, setRatingSubmitting] = useState<Record<string, boolean>>({});
  const [ratingThanks, setRatingThanks] = useState<Record<string, boolean>>({});
  const socketRef = useRef<any>(null);

  const fetchProjects = async () => {
    try {
      setLoading(true);
      const res = await apiFetch('api/projects');
      if (!res.ok) throw new Error('Failed to fetch projects');
      const data = await res.json();
      setProjects(data);
      // also fetch stats
      await fetchStats();
    } catch (err) {
      setError('Could not load project list. Ensure the backend is running.');
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const r = await apiFetch('/api/stats');
      if (!r.ok) return;
      const j = await r.json();
      setStats(j);
      setOnline(j.online || 0);
      setVersion(j.version || '1.0.1');
    } catch (e) {}
  };

  // Helper: smart fetch that tries both base-relative (document.baseURI) and root paths
  async function apiFetch(endpoint: string, opts?: RequestInit) {
    // normalize endpoint
    const ep = endpoint.replace(/^[\/]+/, '');

    // candidate 1: relative to page's base (works when app is mounted at /games/)
    let candidates: string[] = [];
    try {
      if (typeof document !== 'undefined' && document.baseURI) {
        candidates.push(new URL(ep, document.baseURI).toString());
      }
    } catch (e) {}

    // candidate 2: absolute to origin root (/api/...)
    try {
      candidates.push(new URL('/' + ep, window.location.origin).toString());
    } catch (e) {}

    // Try sequential candidates until we get a successful response
    for (const url of candidates) {
      try {
        console.debug('[apiFetch] trying', url);
        const resp = await fetch(url, opts);
        // Accept 2xx/3xx as success. If 4xx/5xx, try next candidate.
        if (resp && (resp.ok || (resp.status >= 200 && resp.status < 400))) return resp;
      } catch (e: any) {
        console.debug('[apiFetch] failed', url, e?.message || e);
        // network error -> try next candidate
      }
    }

    // Fallback: try fetch with endpoint as-is
    return fetch(endpoint, opts);
  }

  useEffect(() => {
    fetchProjects();

    // setup socket connection for real-time updates
    try {
      // dynamic import to keep the code tree-shake friendly
      (async () => {
        const mod = await import('socket.io-client');

        // build candidate paths for socket.io
        const ep = 'socket.io/';
        const candidates: string[] = [];
        try { if (typeof document !== 'undefined' && document.baseURI) candidates.push(new URL(ep, document.baseURI).pathname); } catch(e) {}
        candidates.push('/socket.io');

        let s = null as any;

        // try connecting to each candidate path (first successful wins).
        // Try both relative path and absolute origin+path as some proxies behave differently.
        for (const candidatePath of candidates) {
          console.debug('[socket] trying candidate path:', candidatePath);
          try {
            // attempt as path-only (connect to current origin)
            s = mod.io({ path: candidatePath });
            // wait briefly to detect connection
            const connected = await new Promise(resolve => {
              let done = false;
              const to = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 700);
              s.on('connect', () => { if (!done) { done = true; clearTimeout(to); resolve(true); } });
              s.on('connect_error', () => { if (!done) { done = true; clearTimeout(to); resolve(false); } });
            });
            if (connected) break; // s is connected
            // otherwise disconnect and try next
            try { s.close(); } catch(e) {}
          } catch (e) {
            // if direct path didn't work — try absolute origin URL
            try {
              const origin = window.location.origin;
              const url = origin + (candidatePath.startsWith('/') ? candidatePath : '/' + candidatePath);
              console.debug('[socket] trying absolute URL', url);
              s = mod.io(url, { path: candidatePath });
              const connected2 = await new Promise(resolve => {
                let done = false;
                const to = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 700);
                s.on('connect', () => { if (!done) { done = true; clearTimeout(to); resolve(true); } });
                s.on('connect_error', () => { if (!done) { done = true; clearTimeout(to); resolve(false); } });
              });
              if (connected2) break;
              try { s.close(); } catch(e) {}
            } catch (err2) {
              // try next candidate
            }
          }
        }
          socketRef.current = s;

          if (!s) return;

          s.on('session:update', (payload: any) => {
        setOnline(payload?.online ?? 0);
      });

        s.on('stats:update', ({ stats: newStats }: any) => {
        if (newStats) {
          setStats(newStats);
          setVersion(newStats.version || '1.0.1');
        }
      });
      })();

    } catch (e) {
      // socket may be unavailable — ignore silently
    }
  }, []);

  const handleBuild = async (id: string) => {
    setBuildingId(id);
    try {
      const res = await apiFetch(`api/build/${id}`, { method: 'POST' });
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.details || 'Build failed');
      }
      
      // Refresh list to show "Play" button
      await fetchProjects();
    } catch (err: any) {
      alert(`Build Failed:\n${err.message}`);
    } finally {
      setBuildingId(null);
    }
  };

  const handleLaunch = async (id: string, path: string) => {
    try {
      // record launch server-side
      await apiFetch(`/api/launch/${encodeURIComponent(id)}`, { method: 'POST' });
      // open app in new tab - preserve existing behavior used by anchor
      const href = path?.startsWith('/') ? path.slice(1) : path;
      window.open(href, '_blank');
      // refresh stats
      await fetchStats();
    } catch (e) {
      console.warn('Failed to record launch', e);
    }
  };

  const handleRating = async (id: string, value: number) => {
    setRatingSubmitting(s => ({ ...s, [id]: true }));
    try {
      await apiFetch(`/api/rate/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rating: value })});
      await fetchStats();
      setRatingThanks(s => ({ ...s, [id]: true }));
      setTimeout(() => setRatingThanks(s => ({ ...s, [id]: false })), 1300);
    } catch (e) {
      console.warn('Failed to submit rating', e);
    }
    setRatingSubmitting(s => ({ ...s, [id]: false }));
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-8 font-sans">
      <div className="max-w-7xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="flex items-center justify-between border-b border-gray-800 pb-6">
          <div className="flex items-center space-x-4">
            <div className="bg-indigo-600 p-3 rounded-xl shadow-lg shadow-indigo-900/20">
              <Terminal className="w-8 h-8 text-white" />
            </div>
            <div>
              <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 to-cyan-400">
                PJ App Runner
              </h1>
              <p className="text-gray-400 mt-1">Deploying locally from <span className="font-mono bg-gray-900 px-2 py-0.5 rounded text-sm">/data</span></p>
            </div>
          </div>
          <button 
            onClick={fetchProjects}
            className="p-2 hover:bg-gray-800 rounded-lg transition-colors text-gray-400 hover:text-white"
            title="Refresh List"
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </header>

        {/* Content */}
        <main>
            {error && (
                <div className="bg-red-900/20 border border-red-800 text-red-200 p-4 rounded-lg flex items-center space-x-3 mb-6">
                    <AlertTriangle className="w-5 h-5" />
                    <span>{error}</span>
                </div>
            )}

            {!loading && projects.length === 0 && !error && (
                <div className="text-center py-20 border-2 border-dashed border-gray-800 rounded-2xl">
                    <p className="text-gray-500 text-lg">No projects found in mapped folder.</p>
                    <p className="text-gray-600 text-sm mt-2">Unzip your Gemini/AI Studio exports into the host folder.</p>
                </div>
            )}

            <div className="flex items-center justify-between gap-4 mb-6">
              <div className="flex items-center space-x-3 text-sm text-gray-300">
                <div className="bg-gray-800 px-3 py-2 rounded-lg border border-gray-700">Version <strong className="ml-2">{version}</strong></div>
                <div className="bg-gray-800 px-3 py-2 rounded-lg border border-gray-700">Online <strong className="ml-2">{online}</strong></div>
              </div>
              <div className="text-xs text-gray-400">Statistics are live and persisted on the server.</div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {projects.map((project) => (
                    <div 
                        key={project.id} 
                        className="group bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden hover:border-indigo-500/50 transition-all duration-300 shadow-xl hover:shadow-indigo-900/10 flex flex-col"
                    >
                        {/* Card Header */}
                        <div className="p-6 flex-grow">
                            <div className="flex justify-between items-start mb-4">
                                <h3 className="text-xl font-bold text-gray-100 group-hover:text-indigo-300 transition-colors">
                                    {project.name}
                                </h3>
                                {project.hasDist ? (
                                    <span className="px-2 py-1 bg-green-900/30 text-green-400 text-xs font-medium rounded-full border border-green-800">
                                        Ready
                                    </span>
                                ) : (
                                    <span className="px-2 py-1 bg-amber-900/30 text-amber-400 text-xs font-medium rounded-full border border-amber-800">
                                        Source Only
                                    </span>
                                )}
                            </div>
                            <p className="text-gray-400 text-sm line-clamp-3 leading-relaxed">
                                {project.description}
                            </p>
                            <div className="mt-4 font-mono text-xs text-gray-600 truncate">
                                ID: {project.id}
                            </div>
                        </div>

                        {/* Card Actions */}
                        <div className="p-4 bg-gray-950/50 border-t border-gray-800 flex items-center justify-between gap-3">
                            {project.hasDist ? (
                              <button
                                onClick={() => handleLaunch(project.id, project.path)}
                                className="flex-1 flex items-center justify-center space-x-2 bg-indigo-600 hover:bg-indigo-500 text-white py-2.5 rounded-lg font-medium transition-colors"
                              >
                                <Play className="w-4 h-4 fill-current" />
                                <span>Launch</span>
                              </button>
                            ) : (
                            <button
                              onClick={() => handleBuild(project.id)}
                              disabled={buildingId === project.id || !project.hasPackageJson}
                              className={`flex-1 flex items-center justify-center space-x-2 py-2.5 rounded-lg font-medium transition-colors border
                                ${buildingId === project.id 
                                  ? 'bg-gray-800 border-gray-700 text-gray-400 cursor-not-allowed' 
                                  : !project.hasPackageJson
                                    ? 'bg-red-900/10 border-red-900/30 text-red-400 cursor-not-allowed'
                                    : 'bg-gray-800 hover:bg-gray-700 border-gray-700 text-gray-200'
                                }`}
                            >
                              {buildingId === project.id ? (
                                <>
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                  <span>Building...</span>
                                </>
                              ) : !project.hasPackageJson ? (
                                <>
                                  <AlertTriangle className="w-4 h-4" />
                                  <span>Invalid</span>
                                </>
                              ) : (
                                <>
                                  <Hammer className="w-4 h-4" />
                                  <span>Build App</span>
                                </>
                              )}
                            </button>
                          )}
                            
                            {project.hasDist && (
                              <a
                                href={project.path?.startsWith('/') ? project.path.slice(1) : project.path}
                                target="_blank"
                                className="p-2.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors border border-transparent hover:border-gray-700"
                                title="Open in new tab"
                              >
                                <ExternalLink className="w-5 h-5" />
                              </a>
                            )}
                            {/* small stats area */}
                            <div className="ml-3 text-xs text-gray-400 text-right">
                              <div>Launched: <strong className="text-gray-200">{stats?.launches?.[project.id] ?? 0}</strong></div>
                              <div className="mt-1">Rating: <strong className="text-gray-200">{(stats?.ratings?.[project.id]?.average ?? 0).toFixed(1)}</strong> <span className="text-gray-500">({stats?.ratings?.[project.id]?.count ?? 0})</span></div>
                            </div>
                        </div>
                          {/* rating control */}
                          <div className="px-4 pb-4 pt-2 flex items-center gap-2">
                            <div className="text-xs text-gray-400 flex items-center gap-1">Rate this app:</div>
                            {[1,2,3,4,5].map((val) => {
                              const avg = stats?.ratings?.[project.id]?.average ?? 0;
                              const active = val <= Math.round(hoverRating[project.id] ?? avg);
                              return (
                                <button key={val}
                                  onMouseEnter={() => setHoverRating(s => ({ ...s, [project.id]: val }))}
                                  onMouseLeave={() => setHoverRating(s => ({ ...s, [project.id]: 0 }))}
                                  onClick={() => handleRating(project.id, val)}
                                  className="p-1 rounded hover:bg-gray-700/40 focus:outline-none"
                                  disabled={ratingSubmitting[project.id]}
                                  title={`Rate ${val}`}>
                                  <span className={`text-sm ${active ? 'text-amber-400 scale-110' : 'text-gray-600'} transition-all duration-150 inline-block`}>★</span>
                                </button>
                              );
                            })}
                            {ratingThanks[project.id] && (
                              <div className="text-xs text-green-300 ml-2">Thanks!</div>
                            )}
                          </div>
                    </div>
                ))}
            </div>
        </main>
      </div>
    </div>
  );
};

export default App;