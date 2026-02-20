# Task #7: Tasks Not Moving to Review State

## Problem Summary

Tasks that were completed internally (via implementation completion in `slack-handler.ts`) were not being synced to Trello's "Review" column. Users had to manually move cards on Trello after implementation completed.

## Root Cause Analysis

The `BoardStore` class had two mechanisms for notifying listeners about changes:

1. **File watcher (fs.watch)**: Triggered when external processes modify `board.json`
2. **Internal writes**: Used `lastWriteHash` tracking to **skip** firing callbacks for own writes

The `TrelloSync` class registered a callback via `store.onChanged()` to trigger outbound sync (local → Trello). However, this callback was only fired for **external** file changes. Internal changes (like `store.moveItem('review')` called from `slack-handler.ts`) were explicitly excluded.

**Code path before fix:**
1. `slack-handler.ts:1741` calls `store.moveItem(item.id, 'review')`
2. `BoardStore.moveItem()` calls `updateItem()` which calls `save()`
3. `save()` sets `lastWriteHash` to track own write
4. File watcher sees the change, but `hash === lastWriteHash` so callback is skipped
5. Trello never gets the update

## Solution

Added a `notifyChanged()` method to `BoardStore` that explicitly fires all registered callbacks. This method is now called after all internal mutations:

- `addItem()`
- `updateItem()` (which covers `moveItem()`)
- `deleteItem()`

**Code path after fix:**
1. `slack-handler.ts:1741` calls `store.moveItem(item.id, 'review')`
2. `BoardStore.moveItem()` calls `updateItem()`
3. `updateItem()` calls `save()` then `notifyChanged()`
4. `notifyChanged()` fires the `TrelloSync` callback
5. `TrelloSync.syncOutbound()` pushes the change to Trello

## Changes Made

### `src/board-store.ts`

1. Added `notifyChanged()` method (lines 218-231):
```typescript
notifyChanged(): void {
  this.logger.debug('Notifying change callbacks', { callbackCount: this.changeCallbacks.length });
  for (const cb of this.changeCallbacks) {
    try {
      cb();
    } catch (err) {
      this.logger.warn('Error in change callback', { error: err });
    }
  }
}
```

2. Added `this.notifyChanged()` calls to:
   - `addItem()` after `save()` (line 123)
   - `updateItem()` after `save()` (line 146)
   - `deleteItem()` after `save()` (line 168)

3. Updated `onChanged()` docstring to reflect that callbacks are now fired for both internal and external changes

### `src/board-api.ts`

Removed redundant `pushSSEUpdate()` calls from API handlers since they are now covered by the `onChanged` callback mechanism:

- `handleAddItem()` - removed line 358
- `handleUpdateItem()` - removed line 431
- `handleDeleteItem()` - removed line 475

### `src/board-store.test.ts`

Updated test case "should NOT fire callback for own writes" to "should fire callback for own writes (for Trello sync)" - this is now the expected behavior.

## Verification

1. All 281 tests pass
2. Build succeeds
3. Bot running in tsx watch mode auto-reloads

## Acceptance Criteria Verification

- [x] Tasks moved to review state internally are synced to Trello
- [x] No duplicate SSE events (removed explicit calls, now handled by callback)
- [x] All existing tests pass (updated expectations)
- [x] Build succeeds
