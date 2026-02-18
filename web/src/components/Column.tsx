import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { BoardColumn, KanbanItem } from '../types';
import { Card } from './Card';
import { AddCardForm } from './AddCardForm';

interface Props {
  column: BoardColumn;
  items: KanbanItem[];
  onCardClick: (item: KanbanItem) => void;
  onAddCard?: (title: string) => void;
}

export function Column({ column, items, onCardClick, onAddCard }: Props) {
  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
    data: { column },
  });

  return (
    <div className="column">
      <div
        className="column-header"
        style={{ borderBottomColor: column.color }}
      >
        {column.label}
        <span className="count-badge">{items.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={`column-items ${isOver ? 'drag-over' : ''}`}
      >
        <SortableContext
          items={items.map(i => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {items.map(item => (
            <Card
              key={item.id}
              item={item}
              onClick={() => onCardClick(item)}
            />
          ))}
        </SortableContext>
      </div>
      {column.id === 'backlog' && onAddCard && (
        <AddCardForm onAdd={onAddCard} />
      )}
    </div>
  );
}
