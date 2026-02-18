import { useState } from 'react';
import { ProjectList } from './components/ProjectList';
import { Board } from './components/Board';

export function App() {
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  return (
    <div className="app">
      <ProjectList
        selectedId={selectedProject}
        onSelect={setSelectedProject}
      />
      <div className="board-container">
        {selectedProject ? (
          <Board projectId={selectedProject} />
        ) : (
          <div className="empty-state">
            Select a project to view its board
          </div>
        )}
      </div>
    </div>
  );
}
