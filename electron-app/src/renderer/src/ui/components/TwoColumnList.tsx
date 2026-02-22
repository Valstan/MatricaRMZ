import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';

function splitInHalves<T>(items: T[]): { left: T[]; right: T[] } {
  const safe = items.filter((item) => item !== undefined);
  const splitAt = Math.ceil(safe.length / 2);
  return {
    left: safe.slice(0, splitAt),
    right: safe.slice(splitAt),
  };
}

function splitInColumns<T>(items: T[], columns: number): T[][] {
  if (columns <= 1) return [items.filter((item) => item !== undefined)];
  if (columns === 2) {
    const halves = splitInHalves(items);
    return [halves.left, halves.right];
  }
  const safe = items.filter((item) => item !== undefined);
  const chunkSize = Math.ceil(safe.length / columns);
  const out: T[][] = [];
  for (let i = 0; i < columns; i += 1) {
    out.push(safe.slice(i * chunkSize, (i + 1) * chunkSize));
  }
  return out;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const rounded = Math.round(value);
  return Math.max(min, Math.min(max, rounded));
}

function readNumberCssVar(root: HTMLElement, name: string, fallback: number): number {
  const raw = getComputedStyle(root).getPropertyValue(name).trim();
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function TwoColumnList<T>(props: {
  items: T[];
  enabled: boolean;
  minColumnWidthPx?: number;
  gapPx?: number;
  maxColumns?: number;
  renderColumn: (items: T[], colIndex: number, colCount: number) => React.ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState({ columns: 1, gap: props.gapPx ?? 10 });
  const measuredItems = useMemo(() => props.items.slice(0, 180), [props.items]);

  useLayoutEffect(() => {
    const recalc = () => {
      const host = hostRef.current;
      const probe = probeRef.current;
      if (!host || !probe) return;
      const root = document.documentElement;
      const autoEnabled = readNumberCssVar(root, '--ui-list-auto-columns-enabled', 1) !== 0;
      const cssMaxColumns = clampInt(readNumberCssVar(root, '--ui-list-auto-columns-max', 3), 1, 3);
      const maxColumns = clampInt(props.maxColumns ?? cssMaxColumns, 1, 3);
      const gap = clampInt(props.gapPx ?? readNumberCssVar(root, '--ui-list-auto-columns-gap-px', 10), 0, 32);

      // Adaptive columns are centrally controlled from UI Control Center.
      const allowAdaptive = autoEnabled;
      if (!allowAdaptive) {
        setLayout((prev) => (prev.columns === 1 && prev.gap === gap ? prev : { columns: 1, gap }));
        return;
      }

      const availableWidth = Math.max(1, host.clientWidth);
      const singleListWidth = Math.max(1, Math.ceil(probe.scrollWidth));
      const fitColumns = Math.floor((availableWidth + gap) / (singleListWidth + gap));
      const columns = clampInt(fitColumns, 1, maxColumns);
      setLayout((prev) => (prev.columns === columns && prev.gap === gap ? prev : { columns, gap }));
    };

    recalc();
    const host = hostRef.current;
    const probe = probeRef.current;
    const observer = new ResizeObserver(() => recalc());
    if (host) observer.observe(host);
    if (probe) observer.observe(probe);
    window.addEventListener('resize', recalc);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', recalc);
    };
  }, [props.gapPx, props.maxColumns, props.items.length, measuredItems.length]);

  const columnsData = useMemo(() => splitInColumns(props.items, layout.columns), [layout.columns, props.items]);

  if (layout.columns <= 1) {
    return (
      <div ref={hostRef} style={{ position: 'relative' }}>
        <div
          ref={probeRef}
          aria-hidden="true"
          style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none', width: 'max-content', maxWidth: 'none', left: -100000, top: 0 }}
        >
          {props.renderColumn(measuredItems, 0, 1)}
        </div>
        {props.renderColumn(props.items, 0, 1)}
      </div>
    );
  }

  return (
    <div ref={hostRef} style={{ position: 'relative' }}>
      <div
        ref={probeRef}
        aria-hidden="true"
        style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none', width: 'max-content', maxWidth: 'none', left: -100000, top: 0 }}
      >
        {props.renderColumn(measuredItems, 0, 1)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`, gap: layout.gap }}>
        {columnsData.map((columnItems, colIndex) => (
          <div key={`list-col-${colIndex}`} style={{ minWidth: 0 }}>
            {props.renderColumn(columnItems, colIndex, layout.columns)}
          </div>
        ))}
      </div>
    </div>
  );
}


