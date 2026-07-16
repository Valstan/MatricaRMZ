export type PrintSection = {
  id: string;
  title: string;
  html: string;
  checked?: boolean;
  /** Не печатать заголовок секции (<h2>). Чекбокс-переключатель (по title) остаётся. */
  hideTitle?: boolean;
};

export function escapeHtml(s: string) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/** Базовый CSS печатной формы — общий для окна печати и живого A4-превью (iframe). */
export const PRINT_BASE_CSS = `
    body { font-family: system-ui, Arial, sans-serif; margin: 24px; color: #0b1220; }
    h1 { margin: 0 0 6px 0; font-size: 20px; }
    h2 { margin: 0 0 8px 0; font-size: 14px; }
    .subtitle { color: #6b7280; font-size: 12px; margin-bottom: 14px; }
    .controls { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; align-items: center; }
    .toggle { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: #111827; cursor: pointer; }
    .action { margin-left: auto; }
    button { border: 1px solid #cbd5f5; background: #2563eb; color: #fff; padding: 6px 12px; border-radius: 8px; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; font-size: 12px; vertical-align: top; }
    th { background: #f8fafc; }
    ul { margin: 0; padding-left: 18px; }
    .section { margin-bottom: 16px; }
    .muted { color: #6b7280; }
    @media print {
      .no-print { display: none !important; }
      body { margin: 12mm; color: #0b1220; }
      .section { break-inside: avoid-page; page-break-inside: avoid; }
      .wo-print-works-footer { break-inside: avoid-page; page-break-inside: avoid; margin-top: 10px; }
      table { break-inside: auto; }
    }`;

function renderSectionsHtml(sections: PrintSection[]): string {
  return sections
    .map((s) => {
      const html = s.html?.trim() ? s.html : `<div class="muted">Нет данных</div>`;
      const heading = s.hideTitle ? '' : `<h2>${escapeHtml(s.title)}</h2>`;
      return `<section class="section" data-print-section="${escapeHtml(s.id)}">
  ${heading}
  ${html}
</section>`;
    })
    .join('\n');
}

/**
 * Standalone A4-документ для живого предпросмотра в iframe: только печатный контент,
 * без управляющих элементов; контент шириной с A4-лист (186мм = 210 − 2×12мм поля).
 * Высоту печатной области одной страницы (273мм) меряет вызывающий по scrollHeight.
 */
export function buildWorkOrderA4PreviewHtml(opts: { sections: PrintSection[]; extraCss?: string; landscape?: boolean; marginMm?: number }): string {
  const content = renderSectionsHtml(opts.sections);
  const w = opts.landscape ? 297 : 210;
  const h = opts.landscape ? 210 : 297;
  const m = opts.marginMm ?? 12;
  return `<!doctype html><html><head><meta charset="utf-8"/><style>${PRINT_BASE_CSS}
    html, body { margin: 0; background: #e7e9ef; }
    /* Лист A4 как на печати: поля внутри как padding (перенос строк 1:1 с печатью). */
    #wo-a4 {
      box-sizing: border-box;
      width: ${w}mm;
      min-height: ${h}mm;
      padding: ${m}mm;
      margin: 0 auto;
      background: #fff;
      box-shadow: 0 1px 8px rgba(15,23,42,0.20);
    }
    ${opts.extraCss ?? ''}
  </style></head><body><div id="wo-a4">${content}</div></body></html>`;
}

/**
 * Прямая печать секций: служебное окно без чекбоксов/кнопок — сразу системный диалог печати.
 * Состав секций выбирает вызывающий (например, диалог настроек печати табеля).
 * NB: inline <script> в document.write-окне Electron не исполняется — print() зовём из opener.
 */
export function printSectionsDirect(opts: { title: string; sections: PrintSection[]; extraCss?: string }) {
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(opts.title)}</title>
  <style>${PRINT_BASE_CSS}
    body { margin: 0; }
    ${opts.extraCss ?? ''}
  </style>
</head>
<body>
${renderSectionsHtml(opts.sections)}
</body>
</html>`;
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => {
    w.addEventListener('afterprint', () => w.close());
    w.focus();
    w.print();
  }, 250);
}

export function openPrintPreview(opts: { title: string; subtitle?: string; sections: PrintSection[]; extraCss?: string }) {
  const title = escapeHtml(opts.title);
  const subtitle = opts.subtitle ? escapeHtml(opts.subtitle) : '';

  const visibilityCss = opts.sections
    .map((s) => {
      const id = escapeHtml(s.id);
      return `body:has(input[data-section="${id}"]:not(:checked)) [data-print-section="${id}"] { display: none !important; }`;
    })
    .join('\n    ');

  const controls = opts.sections
    .map((s) => {
      const checked = s.checked === false ? '' : 'checked';
      return `<label class="toggle">
  <input type="checkbox" data-section="${escapeHtml(s.id)}" ${checked}/>
  <span>${escapeHtml(s.title)}</span>
</label>`;
    })
    .join('\n');
  // NB: no inline `display:none` on unchecked sections. The print window is
  // opened via document.write(), whose inline <script> does NOT execute in the
  // Electron child window — so applyVis never runs there. Section visibility is
  // therefore driven purely by the CSS `:has(:not(:checked))` rule below, which
  // can both hide AND reveal as checkboxes toggle. A persistent inline
  // display:none would shadow that rule (CSS can't un-hide an inline style),
  // leaving checked sections stuck hidden — the "blank page" bug.
  const content = renderSectionsHtml(opts.sections);

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${title}</title>
  <style>${PRINT_BASE_CSS}
    ${visibilityCss}
    ${opts.extraCss ?? ''}
  </style>
</head>
<body>
  <div class="no-print">
    <h1>${title}</h1>
    ${subtitle ? `<div class="subtitle">${subtitle}</div>` : ''}
    <div class="controls">
      ${controls}
      <button class="action" id="printBtn">Печать / PDF</button>
    </div>
  </div>
  ${content}
  <script>
    var toggles = document.querySelectorAll('input[data-section]');
    function applyVis() {
      for (var i = 0; i < toggles.length; i++) {
        var cb = toggles[i];
        var s = document.querySelector('[data-print-section="' + cb.getAttribute('data-section') + '"]');
        if (s) s.style.display = cb.checked ? '' : 'none';
      }
    }
    for (var j = 0; j < toggles.length; j++) toggles[j].addEventListener('change', applyVis);
    applyVis();
    var printBtn = document.getElementById('printBtn');
    if (printBtn) printBtn.addEventListener('click', function() { window.print(); });
  </script>
</body>
</html>`;

  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => {
    const printBtn = w.document.getElementById('printBtn');
    if (printBtn) printBtn.addEventListener('click', () => w.print());
    w.focus();
  }, 200);
}
