import { useState, useEffect } from 'react';
import { Terminal, Play, Loader2, RefreshCw, AlertTriangle, Hammer, ExternalLink } from 'lucide-react';
import { Project } from './types';

const App = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/projects');
      if (!res.ok) throw new Error('Failed to fetch projects');
      const data = await res.json();
      setProjects(data);
    } catch (err) {
      setError('Could not load project list. Ensure the backend is running.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  const handleBuild = async (id: string) => {
    setBuildingId(id);
    try {
      const res = await fetch(`/api/build/${id}`, { method: 'POST' });
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
                Gemini App Runner
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
                                <a 
                                    href={project.path} 
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex-1 flex items-center justify-center space-x-2 bg-indigo-600 hover:bg-indigo-500 text-white py-2.5 rounded-lg font-medium transition-colors"
                                >
                                    <Play className="w-4 h-4 fill-current" />
                                    <span>Launch</span>
                                </a>
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
                                    href={project.path}
                                    target="_blank"
                                    className="p-2.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors border border-transparent hover:border-gray-700"
                                    title="Open in new tab"
                                >
                                    <ExternalLink className="w-5 h-5" />
                                </a>
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