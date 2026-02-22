import { useEffect } from 'react';

function clamp(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function quantile(sorted: number[], q: number) {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(clamp(q, 0, 1) * (sorted.length - 1));
  return sorted[idx] ?? 0;
}

function normalizeText(value: string) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readNumberCssVar(root: HTMLElement, name: string, fallback: number): number {
  const raw = getComputedStyle(root).getPropertyValue(name).trim();
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isMostlyNumeric(value: string) {
  const text = normalizeText(value);
  if (!text) return false;
  const stripped = text.replace(/[\s.,:%/\\\-+()]/g, '');
  if (!stripped) return false;
  const digits = stripped.replace(/\D/g, '').length;
  return digits / stripped.length >= 0.75;
}

function recalcAdaptiveTableColumns() {
  const root = document.documentElement;
  const textMaxCh = clamp(readNumberCssVar(root, '--ui-list-text-max-ch', 48), 24, 88);
  const tables = Array.from(document.querySelectorAll('table.list-table')) as HTMLTableElement[];
  for (const table of tables) {
    const wrapper = table.parentElement;
    if (wrapper) wrapper.classList.add('list-table-wrap');

    const headerCells = Array.from(table.querySelectorAll('thead th'));
    const bodyRows = Array.from(table.querySelectorAll('tbody tr')).slice(0, 240);
    const colCount = Math.max(
      headerCells.length,
      ...bodyRows.map((row) => row.querySelectorAll('td,th').length),
    );
    if (colCount <= 0) continue;

    for (let col = 0; col < colCount; col += 1) {
      const headerText = normalizeText(headerCells[col]?.textContent ?? '');
      const lengths: number[] = [];
      let numericVotes = 0;
      let textVotes = 0;
      let hasInteractiveContent = false;

      if (headerText) {
        lengths.push(headerText.length);
        if (isMostlyNumeric(headerText)) numericVotes += 1;
        else textVotes += 1;
      }

      for (const row of bodyRows) {
        const cell = row.querySelectorAll('td,th')[col] as HTMLElement | undefined;
        if (!cell) continue;
        if (cell.querySelector('button,input,select,textarea')) hasInteractiveContent = true;
        const text = normalizeText(cell.textContent ?? '');
        if (!text) continue;
        lengths.push(text.length);
        if (isMostlyNumeric(text)) numericVotes += 1;
        else textVotes += 1;
      }

      if (lengths.length === 0) continue;
      const sorted = lengths.slice().sort((a, b) => a - b);
      // Quantile-based sizing keeps the majority width and ignores rare long outliers.
      const p65 = quantile(sorted, 0.65);
      const p80 = quantile(sorted, 0.8);
      const p90 = quantile(sorted, 0.9);
      const median = quantile(sorted, 0.5);
      const mostlyNumeric = numericVotes > textVotes;

      // Treat all textual columns as "name-like": prioritize readable width for typical text.
      let maxCh = clamp(Math.round(p65 * 0.2 + p80 * 0.55 + p90 * 0.25) + 3, 18, textMaxCh);
      if (mostlyNumeric) maxCh = clamp(Math.round(median + 2), 8, 16);
      if (hasInteractiveContent) maxCh = Math.max(maxCh, 22);

      table.style.setProperty(`--ui-list-col-${col + 1}-max-ch`, String(maxCh));

      // Keep full value available in hover tooltip when visual truncation is applied.
      for (const row of bodyRows) {
        const cell = row.querySelectorAll('td,th')[col] as HTMLElement | undefined;
        if (!cell) continue;
        const text = normalizeText(cell.textContent ?? '');
        if (!text) continue;
        if (text.length > maxCh + 2 && !cell.getAttribute('title')) cell.setAttribute('title', text);
      }
    }
  }
}

export function useAdaptiveListTables() {
  useEffect(() => {
    let rafId = 0;
    const schedule = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        recalcAdaptiveTableColumns();
      });
    };

    schedule();
    const observer = new MutationObserver(() => schedule());
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    window.addEventListener('resize', schedule);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
    };
  }, []);
}

