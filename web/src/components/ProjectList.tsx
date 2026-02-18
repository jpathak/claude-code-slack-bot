import { useProjects } from '../hooks/useProjects';

interface Props {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ProjectList({ selectedId, onSelect }: Props) {
  const { projects, loading, error } = useProjects();

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h1>Kanban Board</h1>
      </div>
      <div className="project-list">
        {loading && <div className="loading-state">Loading...</div>}
        {error && <div className="error-state">{error}</div>}
        {projects.map(project => (
          <div
            key={project.id}
            className={`project-item ${selectedId === project.id ? 'active' : ''}`}
            onClick={() => onSelect(project.id)}
          >
            <span className="project-name">{project.projectName}</span>
            <span className="project-progress">
              {project.statusCounts?.done ?? 0}/{project.itemCount}
            </span>
          </div>
        ))}
        {!loading && !error && projects.length === 0 && (
          <div className="empty-state" style={{ padding: '20px', fontSize: '13px' }}>
            No projects configured yet. Add projects via Slack.
          </div>
        )}
      </div>
    </div>
  );
}
