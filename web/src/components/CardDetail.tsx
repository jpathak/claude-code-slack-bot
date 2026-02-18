import { useState } from 'react';
import type { KanbanItem, KanbanStatus } from '../types';

interface Props {
  item: KanbanItem;
  onClose: () => void;
  onUpdate: (updates: Partial<KanbanItem>) => void;
  onDelete: () => void;
  onMove: (status: KanbanStatus) => void;
}

const STATUS_OPTIONS: { value: KanbanStatus; label: string }[] = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'clarification_needed', label: 'Clarification Needed' },
  { value: 'planning', label: 'Planning' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'review', label: 'Review' },
  { value: 'done', label: 'Done' },
];

const STATUS_COLORS: Record<KanbanStatus, string> = {
  backlog: '#fef08a',
  clarification_needed: '#fdba74',
  planning: '#93c5fd',
  in_progress: '#86efac',
  review: '#c4b5fd',
  done: '#d1d5db',
};

export function CardDetail({ item, onClose, onUpdate, onDelete, onMove }: Props) {
  const [answerText, setAnswerText] = useState('');

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleAnswer = () => {
    if (!answerText.trim()) return;
    onUpdate({
      questions: [],
      description: (item.description || '') + `\n\n**Answer:** ${answerText}`,
      status: 'planning',
    });
    setAnswerText('');
  };

  return (
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div className="modal-content">
        <h3>{item.title}</h3>
        <span
          className="detail-status"
          style={{ background: STATUS_COLORS[item.status] }}
        >
          {STATUS_OPTIONS.find(s => s.value === item.status)?.label}
        </span>

        <div style={{ fontSize: '12px', color: '#666', marginTop: 4 }}>
          #{item.id} &middot; {item.source === 'claude' ? '\u{1f916} Claude' : '\u{1f464} User'}
          &middot; {new Date(item.createdAt).toLocaleDateString()}
        </div>

        {item.description && (
          <div className="detail-section">
            <h4>Description</h4>
            <p style={{ fontSize: '14px', whiteSpace: 'pre-wrap' }}>{item.description}</p>
          </div>
        )}

        {item.acceptanceCriteria && item.acceptanceCriteria.length > 0 && (
          <div className="detail-section">
            <h4>Acceptance Criteria</h4>
            <ul className="ac-list">
              {item.acceptanceCriteria.map((ac, i) => (
                <li key={i}>{ac}</li>
              ))}
            </ul>
          </div>
        )}

        {item.questions && item.questions.length > 0 && (
          <div className="detail-section">
            <h4>Questions from Claude</h4>
            {item.questions.map((q, i) => (
              <div key={i} className="question-item">{q}</div>
            ))}
            <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
              <input
                value={answerText}
                onChange={e => setAnswerText(e.target.value)}
                placeholder="Type your answer..."
                style={{ flex: 1, padding: '8px 10px', border: '1px solid #ddd', borderRadius: 4, fontSize: 14 }}
                onKeyDown={e => e.key === 'Enter' && handleAnswer()}
              />
              <button
                onClick={handleAnswer}
                style={{ padding: '8px 12px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
              >
                Answer
              </button>
            </div>
          </div>
        )}

        <div className="detail-section">
          <h4>Move to</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {STATUS_OPTIONS.filter(s => s.value !== item.status).map(s => (
              <button
                key={s.value}
                onClick={() => onMove(s.value)}
                style={{
                  padding: '4px 10px',
                  background: STATUS_COLORS[s.value],
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="detail-actions">
          <button className="btn-secondary" onClick={onClose}>Close</button>
          <button className="btn-danger" onClick={onDelete}>Delete</button>
        </div>
      </div>
    </div>
  );
}
