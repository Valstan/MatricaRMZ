import { useCallback, useEffect, useState } from 'react';

import type { EngineTagSource } from '../components/EngineTagPrintDialog.js';

/**
 * Очередь печати бирок (владелец 01.10.2026): оператор набирает двигатели из
 * списка галочками и из карточек кнопкой «Бирка», а печатает одним заходом.
 * Живёт в sessionStorage — переживает закрытие диалога и hopping по карточкам,
 * но не переживает перезапуск программы (это набор на сейчас, не архив).
 * Все экземпляры хука синхронизируются событием — список и диалог видят одно.
 */

export type TagQueueItem = EngineTagSource & {
  engineId: string;
  /** Снята — в превью и печать не идёт, но из очереди не выкидывается. */
  checked: boolean;
};

const STORAGE_KEY = 'matrica:print:engineTags:queue';
const QUEUE_CAP = 200;
const SYNC_EVENT = 'matrica:tag-queue-changed';

function readQueue(): TagQueueItem[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is TagQueueItem => Boolean(v) && typeof v === 'object' && typeof (v as TagQueueItem).engineId === 'string')
      .slice(0, QUEUE_CAP);
  } catch {
    return [];
  }
}

function writeQueue(items: TagQueueItem[]): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, QUEUE_CAP)));
  } catch {
    // ignore persistence errors
  }
  window.dispatchEvent(new Event(SYNC_EVENT));
}

function mergeItems(prev: TagQueueItem[], incoming: Array<EngineTagSource & { engineId: string }>): TagQueueItem[] {
  const seen = new Set(prev.map((i) => i.engineId));
  const out = [...prev];
  for (const item of incoming) {
    const engineId = String(item.engineId ?? '');
    if (!engineId || seen.has(engineId)) continue;
    seen.add(engineId);
    out.push({ ...item, engineId, checked: true });
  }
  return out.slice(0, QUEUE_CAP);
}

export function useTagPrintQueue() {
  const [items, setItems] = useState<TagQueueItem[]>(() => readQueue());

  useEffect(() => {
    const resync = () => setItems(readQueue());
    window.addEventListener(SYNC_EVENT, resync);
    return () => window.removeEventListener(SYNC_EVENT, resync);
  }, []);

  const commit = useCallback((next: TagQueueItem[]) => {
    setItems(next);
    writeQueue(next);
  }, []);

  const enqueue = useCallback(
    (incoming: Array<EngineTagSource & { engineId: string }>) => {
      const next = mergeItems(readQueue(), incoming);
      commit(next);
      return next;
    },
    [commit],
  );

  const setChecked = useCallback(
    (engineId: string, checked: boolean) => {
      commit(readQueue().map((i) => (i.engineId === engineId ? { ...i, checked } : i)));
    },
    [commit],
  );

  const remove = useCallback(
    (engineId: string) => {
      commit(readQueue().filter((i) => i.engineId !== engineId));
    },
    [commit],
  );

  const clear = useCallback(() => {
    commit([]);
  }, [commit]);

  return { items, enqueue, setChecked, remove, clear };
}
