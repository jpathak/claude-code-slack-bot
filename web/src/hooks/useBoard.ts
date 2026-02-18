import { useState, useEffect, useCallback, useRef } from 'react';
import type { BoardData, KanbanItem, KanbanStatus } from '../types';

export function useBoard(projectId: string | null) {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Fetch board data
  const fetchBoard = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/board`);
      if (!res.ok) throw new Error(`Failed to fetch board: ${res.status}`);
      const data = await res.json();
      setBoard(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Subscribe to SSE for real-time updates
  useEffect(() => {
    if (!projectId) return;

    fetchBoard();

    const es = new EventSource(`/api/projects/${projectId}/board/events`);
    eventSourceRef.current = es;

    // Server sends named 'board-update' events
    const handleBoardUpdate = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as BoardData;
        setBoard(data);
      } catch {
        // Ignore parse errors (e.g., heartbeat)
      }
    };

    es.addEventListener('board-update', handleBoardUpdate);

    es.onerror = () => {
      // EventSource will auto-reconnect
    };

    return () => {
      es.removeEventListener('board-update', handleBoardUpdate);
      es.close();
      eventSourceRef.current = null;
    };
  }, [projectId, fetchBoard]);

  // Add item
  const addItem = useCallback(async (title: string, description?: string) => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/board/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description }),
      });
      if (!res.ok) throw new Error(`Failed to add item: ${res.status}`);
      // SSE will push the update
    } catch (err) {
      setError((err as Error).message);
    }
  }, [projectId]);

  // Update item
  const updateItem = useCallback(async (itemId: string, updates: Partial<KanbanItem>) => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/board/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error(`Failed to update item: ${res.status}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [projectId]);

  // Move item to a column
  const moveItem = useCallback(async (itemId: string, newStatus: KanbanStatus) => {
    if (!projectId) return;
    // Optimistic update
    setBoard(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map(item =>
          item.id === itemId ? { ...item, status: newStatus } : item
        ),
      };
    });

    try {
      const res = await fetch(`/api/projects/${projectId}/board/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error(`Failed to move item: ${res.status}`);
    } catch (err) {
      setError((err as Error).message);
      fetchBoard(); // Revert on error
    }
  }, [projectId, fetchBoard]);

  // Delete item
  const deleteItem = useCallback(async (itemId: string) => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/board/items/${itemId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`Failed to delete item: ${res.status}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [projectId]);

  return { board, loading, error, addItem, updateItem, moveItem, deleteItem, refresh: fetchBoard };
}
