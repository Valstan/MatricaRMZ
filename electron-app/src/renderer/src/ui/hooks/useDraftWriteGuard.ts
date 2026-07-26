import { useRef } from 'react';

// Serializes draft autosave vs commit-time clear. A debounced autosave that is
// still in flight when the operator hits «Сохранить» lands AFTER the clear and
// resurrects the draft (deletedAt: null) — the card then pops up on next start
// as an «unsaved» ghost. Originally fixed inline in WorkOrderDetailsPage
// (draftWriteRef); this hook propagates the same guard to every card page.
export function useDraftWriteGuard() {
  const writeRef = useRef<Promise<unknown> | null>(null);

  /** Run a draft upsert, tracking it so a concurrent clear can wait it out. */
  async function guardDraftWrite<T>(fn: () => Promise<T>): Promise<T> {
    const write = fn();
    writeRef.current = write;
    try {
      return await write;
    } finally {
      if (writeRef.current === write) writeRef.current = null;
    }
  }

  /** Wait for an in-flight draft upsert (if any) before clearing the draft. */
  async function awaitPendingDraftWrite() {
    if (writeRef.current) await writeRef.current.catch(() => undefined);
  }

  return { guardDraftWrite, awaitPendingDraftWrite };
}
