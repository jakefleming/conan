# File Resilience: Never Lose Context on Move/Rename

## Problem
When a user moves or renames a file outside of Conan, all comments, annotations, regions, audio recordings, and status are lost. The `.context.json` entry remains keyed to the old filename/location as an orphan, while the file at its new path has no context.

## Current State
We already have:
- `computeFileHash(filePath)` — SHA-256 of first 64KB of file content
- `findOrphans(subdir)` — finds `.context.json` entries where the file no longer exists
- `reconcileAll()` — walks all dirs, matches orphans to unmatched files by hash, migrates context
- `hash` field in `FileContext` — populated on first comment

**What's missing:**
1. Hashes aren't computed for ALL files — only when a comment is first added
2. `reconcileAll()` is never called automatically
3. The file watcher doesn't detect moves/renames
4. The indexer doesn't trigger reconciliation
5. No UI feedback when files are reconciled
6. Rename within Conan isn't supported at all

## Plan

### Phase 1: Hash Everything on First Scan
**Goal:** Every file gets a fingerprint stored in `.context.json` so we can track it.

**Changes to `server.ts`:**
- After `readContext()` on directory load, compute hashes for any files missing them
- Add a `backfillHashes(subdir)` function that:
  1. Reads `.context.json` for the directory
  2. For each file in the directory, if it has no entry OR entry has no hash, compute the hash
  3. Creates/updates the entry with the hash (preserving any existing comments)
  4. Writes back to `.context.json`
- Call `backfillHashes()` during initial server startup (async, non-blocking)
- Only hash image/text/pdf files (skip directories)

**Data model change:**
```json
{
  "IMG_5210.jpeg": {
    "comments": [...],
    "status": "pending",
    "hash": "a1b2c3d4..."
  },
  "meeting-notes.txt": {
    "comments": [],
    "status": "pending",
    "hash": "e5f6g7h8..."
  }
}
```

Files with no comments still get a hash entry with empty comments and "pending" status. This means `.context.json` will have entries for ALL files, not just annotated ones. This is the key change — it means we can always detect when a file disappears and where it went.

**Tradeoff:** `.context.json` files get larger (one entry per file). For a directory with 100 files, this is ~5KB — negligible.

### Phase 2: Automatic Reconciliation on Scan
**Goal:** Every time we scan directories, automatically detect and fix moved/renamed files.

**Changes to `server.ts`:**
- Modify the `/api/files` endpoint to run lightweight orphan detection:
  1. After reading context, check for orphans (entries where file doesn't exist)
  2. If orphans found, trigger `reconcileAll()` in background
  3. Return files immediately (don't block on reconciliation)
- Modify `reconcileAll()` to also update the SQLite index after migration
- Add a `/api/reconcile` endpoint for manual trigger
- Add a notification system: after reconciliation, store results so the UI can show "3 files were automatically reconnected"

**Changes to `indexer.ts`:**
- After `fullScan()`, call a new `reconcileMovedFiles()` method on the server
- Or better: have the indexer emit events that the server listens to

### Phase 3: Real-Time Watcher Detection
**Goal:** Detect moves/renames as they happen (while server is running).

**Changes to `indexer.ts` watcher:**
- The `fs.watch` API fires `rename` events for both the old and new paths
- Track rapid pairs of delete+create as potential moves:
  1. When a file disappears (delete event), store its path + timestamp in a "recently deleted" map
  2. When a new file appears (create event) within 2 seconds, compute its hash
  3. If the hash matches a recently deleted file, it's a move/rename
  4. Trigger context migration immediately
- This gives real-time reconciliation without waiting for next scan

**Implementation detail:**
```typescript
private recentlyDeleted = new Map<string, { hash: string; timestamp: number }>();

// On delete event:
const hash = this.getStoredHash(deletedPath); // from SQLite
this.recentlyDeleted.set(hash, { path: deletedPath, timestamp: Date.now() });

// On create event:
const newHash = await computeFileHash(newPath);
const match = this.recentlyDeleted.get(newHash);
if (match && Date.now() - match.timestamp < 2000) {
  // This is a move/rename! Migrate context.
  await migrateContext(match.path, newPath);
  this.recentlyDeleted.delete(newHash);
}

// Cleanup old entries every 5 seconds
setInterval(() => {
  const cutoff = Date.now() - 5000;
  for (const [hash, info] of this.recentlyDeleted) {
    if (info.timestamp < cutoff) this.recentlyDeleted.delete(hash);
  }
}, 5000);
```

### Phase 4: In-App Rename
**Goal:** Let users rename files directly in Conan without losing context.

**UI changes (`public/index.html`):**
- Double-click filename in sidebar header → editable text field
- Or: right-click context menu → "Rename"
- On confirm: call new `/api/files/:path/rename` endpoint

**Server endpoint (`server.ts`):**
```
PUT /api/files/:path/rename
Body: { newName: "new-filename.jpeg" }
```
- Rename the physical file on disk
- Update `.context.json`: delete old key, insert new key with same context
- Update `.thumbs/` thumbnail filename
- Update `.audio/` references if any
- Update SQLite index
- Return success with new path

### Phase 5: UI Feedback
**Goal:** Users know when reconciliation happens.

- Toast notification: "📎 3 files reconnected after move/rename"
- In the orphan indicator (if we have one), show count of unresolved orphans
- Optional: reconciliation log accessible from settings/index panel

## File Structure Changes

No new files. Changes to:
- `server.ts` — backfillHashes, enhanced reconcileAll, rename endpoint, auto-reconcile on scan
- `indexer.ts` — real-time move detection in watcher, hash lookup from SQLite
- `public/index.html` — rename UI, toast notifications for reconciliation

## Edge Cases

| Scenario | Handling |
|----------|----------|
| File moved while server off | Caught by Phase 2 (reconcile on next scan) |
| File renamed while server off | Caught by Phase 2 (same hash, different name) |
| File moved while server running | Caught by Phase 3 (real-time watcher) |
| File content edited + moved simultaneously | Hash won't match. Orphan remains. User can manually reassign. |
| Two identical files (same hash) | First match wins. Second stays orphaned. Rare edge case. |
| File deleted (not moved) | Orphan remains in `.context.json`. Could add cleanup after N days. |
| Bulk move (entire folder) | reconcileAll handles this — walks all dirs |
| `.attachments/` files for comments | Attachments use relative paths — if parent file moves, attachment refs still work since they're stored in `.attachments/` at project root |

## Implementation Order

1. **Phase 1** — Hash everything (~30 min)
2. **Phase 2** — Auto-reconcile on scan (~20 min)
3. **Phase 3** — Real-time watcher (~30 min)
4. **Phase 4** — In-app rename (~30 min)
5. **Phase 5** — UI feedback (~15 min)

Total: ~2 hours

## Risk Assessment

- **Low risk:** Phases 1-2 are additive — they don't change existing behavior, just add hash entries and auto-run existing reconcileAll()
- **Medium risk:** Phase 3 watcher changes could cause false positives if two different files have identical first-64KB content (extremely unlikely for images/PDFs)
- **Low risk:** Phase 4 rename is a well-contained feature with clear boundaries
