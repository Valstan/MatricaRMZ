import QRCode from 'qrcode';

import { escapeHtml } from './printPreview.js';

/**
 * QR-этикетки для номенклатуры/складских мест (brain-бэклог #4, печать без железа).
 *
 * Генерация QR как ИНЛАЙН-SVG в главном окне (рендерер), затем вставка готового
 * SVG в печатное окно. Важно: инлайн-`<script>` в окне печати Electron НЕ исполняется
 * (GOTCHAS / printPreview.ts) — поэтому QR нельзя рисовать скриптом на лету, только
 * пред-сгенерированным SVG. Всё офлайн, без внешних зависимостей рантайма.
 */

export type LabelTarget = {
  id: string;
  /** Человекочитаемый код (артикул/код места). Может быть пустым. */
  code: string;
  /** Наименование для подписи под QR. */
  name: string;
  /** Доп. строка (напр. цех/группа/склад). */
  subtitle?: string | null;
};

export type LabelSheetOptions = {
  /** Что кодировать в QR: код (сканер найдёт по barcode/code) или стабильный id. */
  encode: 'code' | 'id';
  /** Колонок на листе A4. */
  columns: number;
  /** Копий каждой этикетки. */
  copies: number;
};

/** Значение, кодируемое в QR: по опции code (fallback id) либо id. */
export function labelQrValue(t: LabelTarget, encode: LabelSheetOptions['encode']): string {
  if (encode === 'id') return t.id;
  const code = String(t.code ?? '').trim();
  return code || t.id;
}

async function generateQrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
}

const LABELS_CSS = `
  * { box-sizing: border-box; }
  body { font-family: system-ui, Arial, sans-serif; margin: 0; color: #0b1220; background: #e7e9ef; }
  .no-print { padding: 10px 14px; display: flex; gap: 10px; align-items: center; }
  .no-print button { border: 1px solid #cbd5f5; background: #2563eb; color: #fff; padding: 6px 12px; border-radius: 8px; cursor: pointer; }
  .no-print .muted { color: #6b7280; font-size: 12px; }
  #sheet { background: #fff; margin: 0 auto; padding: 8mm; width: 210mm; display: grid; gap: 4mm; }
  .label {
    border: 1px solid #cbd5e1; border-radius: 3mm; padding: 3mm;
    display: flex; gap: 3mm; align-items: center; break-inside: avoid; page-break-inside: avoid; min-height: 0;
  }
  .label .qr { flex-shrink: 0; width: 22mm; height: 22mm; }
  .label .qr svg { width: 100%; height: 100%; display: block; }
  .label .meta { min-width: 0; overflow: hidden; }
  .label .meta .name { font-weight: 700; font-size: 11pt; line-height: 1.15; word-break: break-word; }
  .label .meta .code { font-size: 10pt; color: #111827; margin-top: 1mm; font-variant-numeric: tabular-nums; }
  .label .meta .sub { font-size: 8pt; color: #6b7280; margin-top: 1mm; word-break: break-word; }
  @media print {
    body { background: #fff; }
    .no-print { display: none !important; }
    #sheet { box-shadow: none; padding: 8mm; }
  }`;

function renderLabelHtml(t: LabelTarget, qrSvg: string): string {
  const code = String(t.code ?? '').trim();
  const sub = String(t.subtitle ?? '').trim();
  return `<div class="label">
  <div class="qr">${qrSvg}</div>
  <div class="meta">
    <div class="name">${escapeHtml(t.name || '—')}</div>
    ${code ? `<div class="code">${escapeHtml(code)}</div>` : ''}
    ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ''}
  </div>
</div>`;
}

/**
 * Пред-генерирует QR для каждой цели, раскладывает сеткой этикеток на A4 и открывает
 * окно печати. Копии/колонки — из опций. Возвращает число напечатанных этикеток.
 */
export async function openLabelsPrint(targets: ReadonlyArray<LabelTarget>, options: LabelSheetOptions): Promise<number> {
  const copies = Math.max(1, Math.trunc(options.copies) || 1);
  const columns = Math.min(6, Math.max(1, Math.trunc(options.columns) || 3));

  // QR одинакового значения кэшируем, чтобы не гонять генератор на копиях.
  const svgCache = new Map<string, string>();
  const blocks: string[] = [];
  for (const t of targets) {
    const value = labelQrValue(t, options.encode);
    let svg = svgCache.get(value);
    if (!svg) {
      svg = await generateQrSvg(value);
      svgCache.set(value, svg);
    }
    const labelHtml = renderLabelHtml(t, svg);
    for (let c = 0; c < copies; c += 1) blocks.push(labelHtml);
  }

  if (blocks.length === 0) return 0;

  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Этикетки QR</title>
<style>${LABELS_CSS}
  #sheet { grid-template-columns: repeat(${columns}, 1fr); }
</style></head>
<body>
  <div class="no-print">
    <button id="printBtn" type="button">Печать / PDF</button>
    <span class="muted">Этикеток: ${blocks.length} · колонок: ${columns}</span>
  </div>
  <div id="sheet">${blocks.join('\n')}</div>
  <script>
    var b = document.getElementById('printBtn');
    if (b) b.addEventListener('click', function(){ window.print(); });
  </script>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) return 0;
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => {
    const printBtn = w.document.getElementById('printBtn');
    if (printBtn) printBtn.addEventListener('click', () => w.print());
    w.focus();
  }, 200);
  return blocks.length;
}
