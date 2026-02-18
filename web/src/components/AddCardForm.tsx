import { useState } from 'react';

interface Props {
  onAdd: (title: string) => void;
}

export function AddCardForm({ onAdd }: Props) {
  const [isAdding, setIsAdding] = useState(false);
  const [title, setTitle] = useState('');

  const handleSubmit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setTitle('');
    setIsAdding(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit();
    if (e.key === 'Escape') { setIsAdding(false); setTitle(''); }
  };

  if (!isAdding) {
    return (
      <div className="add-card-form">
        <button className="add-btn" onClick={() => setIsAdding(true)}>
          + Add task
        </button>
      </div>
    );
  }

  return (
    <div className="add-card-form">
      <div className="add-input-wrapper">
        <input
          autoFocus
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Task title..."
        />
        <div className="form-actions">
          <button className="save-btn" onClick={handleSubmit}>Add</button>
          <button className="cancel-btn" onClick={() => { setIsAdding(false); setTitle(''); }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
