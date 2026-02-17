import { useCallback, useRef, useState } from 'react';

function valueSignature(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value !== 'object') return `${typeof value}:${String(value)}`;

  if (Array.isArray(value)) {
    const list = value as Array<Record<string, unknown>>;
    const compactTrack = list.every(
      (item) =>
        !!item &&
        typeof item === 'object' &&
        ('id' in item || 'code' in item) &&
        ('updatedAt' in item || 'updated_at' in item || 'syncStatus' in item || 'sync_status' in item || 'state' in item),
    );
    if (compactTrack) {
      const sig = list
        .map((item) => {
          const id = String(item.id ?? item.code ?? '');
          const updatedAt = Number(item.updatedAt ?? item.updated_at ?? 0);
          const syncStatus = String(item.syncStatus ?? item.sync_status ?? item.state ?? '');
          return `${id}:${updatedAt}:${syncStatus}`;
        })
        .join('|');
      return `arr:${list.length}:${sig}`;
    }
  }

  try {
    return `json:${JSON.stringify(value)}`;
  } catch {
    return `opaque:${Object.prototype.toString.call(value)}`;
  }
}

export function useStableState<T>(
  initialValue: T,
  signatureBuilder: (value: T) => string = valueSignature as (value: T) => string,
) {
  const [value, setValueRaw] = useState<T>(initialValue);
  const signatureRef = useRef<string>(signatureBuilder(initialValue));

  const setValue = useCallback((next: T | ((prev: T) => T)) => {
    setValueRaw((prev) => {
      const resolved = typeof next === 'function' ? (next as (prev: T) => T)(prev) : next;
      const nextSig = signatureBuilder(resolved);
      if (nextSig === signatureRef.current) return prev;
      signatureRef.current = nextSig;
      return resolved;
    });
  }, []);

  return [value, setValue] as const;
}

export function useStableArrayState<T>(initialValue: T[] = []) {
  return useStableState<T[]>(initialValue);
}

