import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { KanbanItem } from '../types';

interface Props {
  item: KanbanItem;
  onClick: () => void;
}

export function Card({ item, onClick }: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, data: { item } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card ${isDragging ? 'dragging' : ''}`}
      data-status={item.status}
      onClick={onClick}
      {...attributes}
      {...listeners}
    >
      <div className="card-title">{item.title}</div>
      <div className="card-meta">
        <span className="card-id">#{item.id}</span>
        <span className="source-badge">
          {item.source === 'claude' ? '\u{1f916}' : '\u{1f464}'}
        </span>
        {item.acceptanceCriteria && item.acceptanceCriteria.length > 0 && (
          <span className="ac-count">
            {item.acceptanceCriteria.length} AC
          </span>
        )}
        {item.questions && item.questions.length > 0 && (
          <span className="questions-badge">
            {item.questions.length} Q
          </span>
        )}
      </div>
    </div>
  );
}
