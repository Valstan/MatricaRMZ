import { formatAssemblyVariantLabel } from './assemblyVariant.js';
import { componentTypeLabel } from './componentTypeLabels.js';
import { escapeHtml, type PrintSection } from './printPreview.js';

// Единственное место, где строится HTML печати спецификаций: полная форма (карточка и
// «Печать всех BOM»), компактная «на один лист» и сверка нескольких BOM. Раньше карточка
// и список держали по своей копии — правки расходились (план bom-simplify-2026-09 §4).

export type BomPrintLine = {
  componentNomenclatureId: string;
  componentNomenclatureCode?: string | null;
  componentNomenclatureName?: string | null;
  componentType: string;
  qtyPerUnit: number;
  variantGroup?: string | null;
  lineKey?: string | null;
  parentLineKey?: string | null;
  isRequired: boolean;
  priority: number;
  notes?: string | null;
  normPercent?: number | null;
  positionKey?: string | null;
  positionLabel?: string | null;
  isDefaultOption?: boolean;
};

export type BomPrintDoc = {
  header: { id: string; name: string; engineBrandIds: string[]; version: number; status?: string };
  lines: BomPrintLine[];
};

export type BomPrintLabels = {
  brandsLabel: (ids: string[]) => string;
  typeLabels?: ReadonlyMap<string, string>;
  /** sortOrder типов из схемы — порядок разделов компактной формы и сверки. */
  typeOrder?: ReadonlyMap<string, number>;
};

/** Сколько строк помещается в одну колонку компактной формы (альбомный A4, кегль 9). */
export const BOM_COMPACT_ROWS_PER_COLUMN = 60;

export const BOM_COMPACT_PRINT_CSS = `
  @page { size: A4 landscape; margin: 8mm; }
  th, td { font-size: 9px; padding: 2px 4px; }
  h2 { font-size: 12px; margin: 6px 0 4px; }
  .bom-compact-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: start; }
  .bom-type-row td { background: #f1f5f9; font-weight: 600; }
  .bom-note { color: #6b7280; font-size: 9px; margin: 2px 0 6px; }
`;

export const BOM_COMPARE_PRINT_CSS = `
  @page { size: A4 landscape; margin: 8mm; }
  th, td { font-size: 9px; padding: 2px 4px; }
  .bom-type-row td { background: #f1f5f9; font-weight: 600; }
  td.bom-empty { color: #cbd5e1; text-align: center; }
  td.bom-qty { text-align: center; }
`;

function lineLabel(line: BomPrintLine): string {
  return line.componentNomenclatureName || line.componentNomenclatureCode || line.componentNomenclatureId || '—';
}

function normalizeNodeKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '');
}

function typeRank(typeId: string, order?: ReadonlyMap<string, number>): number {
  return order?.get(typeId) ?? Number.MAX_SAFE_INTEGER;
}

function normalizedType(line: BomPrintLine): string {
  return String(line.componentType ?? 'other').trim().toLowerCase() || 'other';
}

function sortByPriorityThenLabel(a: BomPrintLine, b: BomPrintLine): number {
  const ap = Number(a.priority ?? 100);
  const bp = Number(b.priority ?? 100);
  if (ap !== bp) return ap - bp;
  return lineLabel(a).localeCompare(lineLabel(b), 'ru');
}

function formatNorm(line: BomPrintLine): string {
  const n = line.normPercent;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? `${String(n).replace('.', ',')} %` : '';
}

// ── Полная форма (как было в карточке: база + каждый вариант, дерево «входит в») ─────────

export function buildBomFullSections(lines: BomPrintLine[], typeLabels?: ReadonlyMap<string, string>): PrintSection[] {
  if (!lines.length) {
    return [{ id: 'lines-empty', title: 'Строки спецификации', html: '<div class="muted">Нет строк BOM</div>' }];
  }

  const buildKeyResolver = (chunk: BomPrintLine[]) => {
    const byKey = new Map<string, string>();
    for (const line of chunk) {
      const raw = String(line.lineKey ?? '').trim();
      if (!raw) continue;
      const label = lineLabel(line);
      byKey.set(raw, label);
      const normalized = normalizeNodeKey(raw);
      if (normalized && normalized !== raw && !byKey.has(normalized)) byKey.set(normalized, label);
    }
    return (raw: string | null | undefined): string => {
      const key = String(raw ?? '').trim();
      if (!key) return '—';
      return byKey.get(key) ?? byKey.get(normalizeNodeKey(key)) ?? key;
    };
  };

  const renderTable = (chunk: BomPrintLine[]): string => {
    const resolveKey = buildKeyResolver(chunk);
    const rows = [...chunk]
      .sort(sortByPriorityThenLabel)
      .map((line) => {
        const backup = line.isDefaultOption === false ? ' <span class="muted">(запасной)</span>' : '';
        return `<tr>
          <td>${escapeHtml(componentTypeLabel(line.componentType, typeLabels))}</td>
          <td>${escapeHtml(lineLabel(line))}${backup}</td>
          <td>${escapeHtml(String(Number(line.qtyPerUnit ?? 0)))}</td>
          <td>${escapeHtml(formatNorm(line))}</td>
          <td>${line.isRequired !== false ? 'Да' : 'Нет'}</td>
          <td>${escapeHtml(resolveKey(line.parentLineKey))}</td>
          <td>${escapeHtml(String(line.notes ?? ''))}</td>
        </tr>`;
      })
      .join('');
    return `<table><thead><tr><th>Тип</th><th>Компонент</th><th>Кол-во/двиг.</th><th>Норма</th><th>Обяз.</th><th>Входит в</th><th>Примечание</th></tr></thead><tbody>${rows}</tbody></table>`;
  };

  const baseLines = lines.filter((line) => !String(line.variantGroup ?? '').trim());
  const variantMap = new Map<string, BomPrintLine[]>();
  for (const line of lines) {
    const vg = String(line.variantGroup ?? '').trim();
    if (!vg) continue;
    const arr = variantMap.get(vg) ?? [];
    arr.push(line);
    variantMap.set(vg, arr);
  }
  const sections: PrintSection[] = [];
  if (baseLines.length > 0) {
    sections.push({ id: 'bom-base', title: 'База (общие строки)', html: renderTable(baseLines), checked: true });
  }
  Array.from(variantMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0], 'ru'))
    .forEach(([variantId, variantOnlyLines], idx) => {
      const safeId = `variant-${variantId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'unnamed'}`;
      sections.push({
        id: safeId,
        title: formatAssemblyVariantLabel(variantId, idx),
        html: renderTable([...baseLines, ...variantOnlyLines]),
        checked: true,
      });
    });
  return sections.length ? sections : [{ id: 'bom-lines', title: 'Строки спецификации', html: renderTable(lines), checked: true }];
}

/** «Печать всех BOM»: по секции на спецификацию + легенда компонентов. */
export function buildAllBomsPrintHtml(
  boms: BomPrintDoc[],
  labels: BomPrintLabels,
): { sections: PrintSection[]; legendHtml: string } {
  const componentSet = new Map<string, { name: string; code: string; type: string }>();
  const sections: PrintSection[] = [];
  for (const bom of boms) {
    const brands = labels.brandsLabel((bom.header.engineBrandIds ?? []).map(String));
    const lines = [...bom.lines].sort(sortByPriorityThenLabel);
    for (const line of lines) {
      const id = String(line.componentNomenclatureId ?? '');
      if (id && !componentSet.has(id)) {
        componentSet.set(id, {
          name: line.componentNomenclatureName || '—',
          code: line.componentNomenclatureCode || '—',
          type: componentTypeLabel(line.componentType, labels.typeLabels),
        });
      }
    }
    const rowsHtml = lines
      .map((line) => {
        const vg = String(line.variantGroup ?? '').trim();
        return `<tr><td>${escapeHtml(componentTypeLabel(line.componentType, labels.typeLabels))}</td><td>${escapeHtml(lineLabel(line))}</td><td style="text-align:center">${escapeHtml(String(Number(line.qtyPerUnit ?? 0)))}</td><td style="text-align:center">${line.isRequired !== false ? 'Да' : '—'}</td><td>${vg ? escapeHtml(vg) : '—'}</td></tr>`;
      })
      .join('');
    sections.push({
      id: `bom-${bom.header.id}`,
      title: String(bom.header.name || 'BOM без названия'),
      html: `<div style="margin-bottom:4px;font-size:11px;color:#6b7280">Марки: ${escapeHtml(brands)} · версия ${bom.header.version} · строк: ${lines.length}</div>
<table><thead><tr><th>Тип</th><th>Компонент</th><th style="text-align:center">Кол-во/двиг.</th><th style="text-align:center">Обяз.</th><th>Вариант</th></tr></thead><tbody>${rowsHtml}</tbody></table>`,
      checked: true,
    });
  }
  const legendRows = Array.from(componentSet.values())
    .sort((a, b) => a.type.localeCompare(b.type, 'ru') || a.name.localeCompare(b.name, 'ru'))
    .map((c) => `<tr><td>${escapeHtml(c.type)}</td><td>${escapeHtml(c.code)}</td><td>${escapeHtml(c.name)}</td></tr>`)
    .join('');
  const legendHtml = legendRows
    ? `<table><thead><tr><th>Тип</th><th>Код</th><th>Наименование</th></tr></thead><tbody>${legendRows}</tbody></table>`
    : '<div class="muted">Нет компонентов</div>';
  return { sections, legendHtml };
}

// ── «На один лист»: базовый комплект, только основные варианты, разделы по типу ──────────

type CompactRow = { kind: 'type'; label: string } | { kind: 'line'; line: BomPrintLine };

/** Строки компактной формы: заголовок типа, затем основные варианты позиций базового комплекта. */
export function buildBomCompactRows(lines: BomPrintLine[], labels: Pick<BomPrintLabels, 'typeLabels' | 'typeOrder'>): CompactRow[] {
  const base = lines.filter((l) => !String(l.variantGroup ?? '').trim() && l.isDefaultOption !== false);
  const byType = new Map<string, BomPrintLine[]>();
  for (const line of base) {
    const t = normalizedType(line);
    const arr = byType.get(t) ?? [];
    arr.push(line);
    byType.set(t, arr);
  }
  const rows: CompactRow[] = [];
  Array.from(byType.entries())
    .sort((a, b) => typeRank(a[0], labels.typeOrder) - typeRank(b[0], labels.typeOrder) || a[0].localeCompare(b[0], 'ru'))
    .forEach(([typeId, typeLines]) => {
      rows.push({ kind: 'type', label: `${componentTypeLabel(typeId, labels.typeLabels)} — ${typeLines.length}` });
      for (const line of [...typeLines].sort(sortByPriorityThenLabel)) rows.push({ kind: 'line', line });
    });
  return rows;
}

function renderCompactTable(rows: CompactRow[]): string {
  const body = rows
    .map((row) =>
      row.kind === 'type'
        ? `<tr class="bom-type-row"><td colspan="5">${escapeHtml(row.label)}</td></tr>`
        : `<tr><td>${escapeHtml(row.line.componentNomenclatureCode || '')}</td><td>${escapeHtml(lineLabel(row.line))}</td><td style="text-align:center">${escapeHtml(String(Number(row.line.qtyPerUnit ?? 0)))}</td><td style="text-align:center">${escapeHtml(formatNorm(row.line))}</td><td>${escapeHtml(String(row.line.notes ?? ''))}</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th>Артикул</th><th>Деталь</th><th style="text-align:center">Кол-во</th><th style="text-align:center">Норма</th><th>Примечание</th></tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * Компактная форма: одна таблица; при переполнении колонки — две таблицы рядом
 * (разрез по строкам, заголовок типа не отрывается от первой строки раздела).
 * Варианты-комплекты (`__kit_*`) — короткими секциями «только отличия».
 */
export function buildBomCompactSections(doc: BomPrintDoc, labels: BomPrintLabels): PrintSection[] {
  const rows = buildBomCompactRows(doc.lines, labels);
  const brands = labels.brandsLabel((doc.header.engineBrandIds ?? []).map(String));
  const lineCount = rows.filter((r) => r.kind === 'line').length;
  const backups = doc.lines.filter((l) => !String(l.variantGroup ?? '').trim() && l.isDefaultOption === false).length;
  const note = `Марки: ${escapeHtml(brands)} · версия ${doc.header.version} · позиций: ${lineCount}${backups ? ` · запасных вариантов не печатается: ${backups}` : ''}`;

  let tableHtml: string;
  if (rows.length <= BOM_COMPACT_ROWS_PER_COLUMN) {
    tableHtml = renderCompactTable(rows);
  } else {
    let cut = Math.ceil(rows.length / 2);
    if (rows[cut]?.kind === 'line' && rows[cut - 1]?.kind === 'type') cut -= 1;
    tableHtml = `<div class="bom-compact-columns">${renderCompactTable(rows.slice(0, cut))}${renderCompactTable(rows.slice(cut))}</div>`;
  }
  const sections: PrintSection[] = [
    {
      id: `bom-compact-${doc.header.id}`,
      title: String(doc.header.name || 'BOM без названия'),
      html: `<div class="bom-note">${note}</div>${tableHtml}`,
      checked: true,
    },
  ];

  const kits = new Map<string, BomPrintLine[]>();
  for (const line of doc.lines) {
    const vg = String(line.variantGroup ?? '').trim();
    if (!vg || line.isDefaultOption === false) continue;
    const arr = kits.get(vg) ?? [];
    arr.push(line);
    kits.set(vg, arr);
  }
  Array.from(kits.entries())
    .sort((a, b) => a[0].localeCompare(b[0], 'ru'))
    .forEach(([vg, kitLines], idx) => {
      sections.push({
        id: `bom-compact-kit-${idx}`,
        title: `${formatAssemblyVariantLabel(vg, idx)} — только отличия от базового комплекта`,
        html: renderCompactTable(buildBomCompactRows(kitLines.map((l) => ({ ...l, variantGroup: null })), labels)),
        checked: true,
      });
    });
  return sections;
}

// ── Сверка нескольких BOM: строки — детали, колонки — спецификации ───────────────────────

export type BomCompareRow = { kind: 'type'; label: string } | { kind: 'line'; nomenclatureId: string; code: string; name: string; qty: Array<number | null> };

export function buildBomComparisonRows(docs: BomPrintDoc[], labels: Pick<BomPrintLabels, 'typeLabels' | 'typeOrder'>): BomCompareRow[] {
  type Acc = { code: string; name: string; type: string; qty: Array<number | null> };
  const acc = new Map<string, Acc>();
  docs.forEach((doc, col) => {
    for (const line of doc.lines) {
      if (String(line.variantGroup ?? '').trim() || line.isDefaultOption === false) continue;
      const id = String(line.componentNomenclatureId ?? '');
      if (!id) continue;
      let entry = acc.get(id);
      if (!entry) {
        entry = { code: line.componentNomenclatureCode || '', name: lineLabel(line), type: normalizedType(line), qty: docs.map(() => null) };
        acc.set(id, entry);
      }
      entry.qty[col] = (entry.qty[col] ?? 0) + Number(line.qtyPerUnit ?? 0);
    }
  });
  const byType = new Map<string, Array<[string, Acc]>>();
  for (const pair of acc.entries()) {
    const arr = byType.get(pair[1].type) ?? [];
    arr.push(pair);
    byType.set(pair[1].type, arr);
  }
  const rows: BomCompareRow[] = [];
  Array.from(byType.entries())
    .sort((a, b) => typeRank(a[0], labels.typeOrder) - typeRank(b[0], labels.typeOrder) || a[0].localeCompare(b[0], 'ru'))
    .forEach(([typeId, entries]) => {
      rows.push({ kind: 'type', label: componentTypeLabel(typeId, labels.typeLabels) });
      for (const [id, e] of entries.sort((a, b) => a[1].name.localeCompare(b[1].name, 'ru'))) {
        rows.push({ kind: 'line', nomenclatureId: id, code: e.code, name: e.name, qty: e.qty });
      }
    });
  return rows;
}

export function buildBomComparisonSections(docs: BomPrintDoc[], labels: BomPrintLabels): PrintSection[] {
  const rows = buildBomComparisonRows(docs, labels);
  const head = docs
    .map((d) => `<th style="text-align:center">${escapeHtml(d.header.name || '—')}<div class="muted" style="font-weight:400">${escapeHtml(labels.brandsLabel(d.header.engineBrandIds ?? []))}</div></th>`)
    .join('');
  const body = rows
    .map((row) =>
      row.kind === 'type'
        ? `<tr class="bom-type-row"><td colspan="${2 + docs.length}">${escapeHtml(row.label)}</td></tr>`
        : `<tr><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td>${row.qty
            .map((q) => (q == null ? '<td class="bom-empty">—</td>' : `<td class="bom-qty">${escapeHtml(String(q))}</td>`))
            .join('')}</tr>`,
    )
    .join('');
  const lineCount = rows.filter((r) => r.kind === 'line').length;
  return [
    {
      id: 'bom-compare',
      title: `Сверка спецификаций: ${docs.length} · деталей: ${lineCount}`,
      html: `<table><thead><tr><th>Артикул</th><th>Деталь</th>${head}</tr></thead><tbody>${body}</tbody></table>`,
      checked: true,
    },
  ];
}
