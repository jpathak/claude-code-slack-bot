import { useState, useCallback } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCorners,
} from '@dnd-kit/core';
import { useBoard } from '../hooks/useBoard';
import { Column } from './Column';
import { CardDetail } from './CardDetail';
import type { KanbanItem, KanbanStatus } from '../types';

interface Props {
  projectId: string;
}

export function Board({ projectId }: Props) {
  const { board, loading, error, addItem, updateItem, moveItem, deleteItem } = useBoard(projectId);
  const [selectedCard, setSelectedCard] = useState<KanbanItem | null>(null);
  const [activeItem, setActiveItem] = useState<KanbanItem | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const item = event.active.data.current?.item as KanbanItem | undefined;
    if (item) setActiveItem(item);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveItem(null);

    const { active, over } = event;
    if (!over) return;

    const draggedItem = active.data.current?.item as KanbanItem | undefined;
    if (!draggedItem) return;

    // Determine the target column
    let targetStatus: KanbanStatus;

    // "over" could be a column or another card
    const overColumn = over.data.current?.column;
    const overItem = over.data.current?.item as KanbanItem | undefined;

    if (overColumn) {
      targetStatus = overColumn.id;
    } else if (overItem) {
      targetStatus = overItem.status;
    } else {
      // over.id is the column id (droppable id)
      targetStatus = over.id as KanbanStatus;
    }

    if (draggedItem.status !== targetStatus) {
      moveItem(draggedItem.id, targetStatus);
    }
  }, [moveItem]);

  const handleDragOver = useCallback((_event: DragOverEvent) => {
    // Could implement optimistic column highlighting here
  }, []);

  if (loading) return <div className="loading-state">Loading board...</div>;
  if (error) return <div className="error-state">Error: {error}</div>;
  if (!board) return <div className="empty-state">No board data</div>;

  const getColumnItems = (columnId: KanbanStatus): KanbanItem[] => {
    return board.items.filter(i => i.status === columnId);
  };

  const done = board.items.filter(i => i.status === 'done').length;
  const total = board.items.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <>
      <div className="board-header">
        <h2>{board.projectName}</h2>
        <span className="board-meta">
          {done}/{total} done ({pct}%) &middot; Updated {new Date(board.updatedAt).toLocaleTimeString()}
        </span>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="board">
          {board.columns.map(col => (
            <Column
              key={col.id}
              column={col}
              items={getColumnItems(col.id)}
              onCardClick={setSelectedCard}
              onAddCard={col.id === 'backlog' ? (title) => addItem(title) : undefined}
            />
          ))}
        </div>

        <DragOverlay>
          {activeItem && (
            <div
              className="card dragging"
              data-status={activeItem.status}
            >
              <div className="card-title">{activeItem.title}</div>
              <div className="card-meta">
                <span className="card-id">#{activeItem.id}</span>
              </div>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {selectedCard && (
        <CardDetail
          item={selectedCard}
          onClose={() => setSelectedCard(null)}
          onUpdate={(updates) => {
            updateItem(selectedCard.id, updates);
            setSelectedCard(null);
          }}
          onDelete={() => {
            deleteItem(selectedCard.id);
            setSelectedCard(null);
          }}
          onMove={(status) => {
            moveItem(selectedCard.id, status);
            setSelectedCard(null);
          }}
        />
      )}
    </>
  );
}
