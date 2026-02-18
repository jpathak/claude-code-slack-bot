import { useState, useEffect } from 'react';
import type { ProjectSummary } from '../types';

export function useProjects() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchProjects() {
      try {
        const res = await fetch('/api/projects');
        if (!res.ok) throw new Error(`Failed to fetch projects: ${res.status}`);
        const data = await res.json();
        // API returns { projects: [...] }
        setProjects(Array.isArray(data) ? data : data.projects ?? []);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }

    fetchProjects();
    // Refresh every 30 seconds
    const interval = setInterval(fetchProjects, 30000);
    return () => clearInterval(interval);
  }, []);

  return { projects, loading, error };
}
