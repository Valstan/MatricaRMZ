import { PRINT_MARGIN_MM, type PrintOrientation } from './listPrintLayout.js';

export type PrintSection = {
  id: string;
  title: string;
  html: string;
  checked?: boolean;
  /** Не печатать заголовок секции (<h2>). Чекбокс-переключатель (по title) остаётся. */
  hideTitle?: boolean;
};

/** Шапка печатного документа: она печатается, а не только видна в окне. */
export type PrintHeader = {
  title: string;
  /** Строки отбора человеческим языком. */
  lines?: readonly string[];
  /** Кто и когда печатал. */
  meta?: string;
};

/** Состояние окна предпросмотра: переключатели меняют его и перерисовывают документ на месте. */
export type PrintPreviewState = {
  orientation: PrintOrientation;
  fontSizePt: number;
  /** Кегль выбран оператором вручную; до первого такого выбора его подбирает раскладка. */
  fontSizePinned: boolean;
};

/** Что раскладка решила про лист: только эти два числа окно и показывает переключателями. */
export type PrintPreviewPlan = {
  orientation: PrintOrientation;
  fontSizePt: number;
};

export type PrintPreviewOptions = {
  title: string;
  subtitle?: string;
  /**
   * Разделы документа. Функция от состояния окна — для таблиц, которые пересобираются под
   * выбранный лист и кегль (ширины колонок задаются `<colgroup>` внутри разметки, CSS их
   * не перепишет).
   */
  sections: PrintSection[] | ((state: PrintPreviewState) => PrintSection[]);
  /**
   * Разметка документа. Функция от состояния окна — чтобы переключатели кегля и ориентации
   * пересчитывали ширины таблицы: иначе на альбомном листе таблица осталась бы узкой полосой
   * книжного, а на мелком кегле в те же колонки по-прежнему не влезало бы ничего.
   */
  extraCss?: string | ((state: PrintPreviewState) => string);
  /** Ориентация листа; по умолчанию книжная. */
  orientation?: PrintOrientation;
  /** Кегль таблицы в pt; не задан — кегль по умолчанию из PRINT_BASE_CSS. */
  fontSizePt?: number;
  /** Переключатели в окне: перерисовывают документ на месте, не открывая новое окно. */
  orientationSwitch?: boolean;
  fontSizeSwitch?: boolean;
  /** Шапка документа вместо заголовка окна — печатается вместе с таблицей. */
  printHeader?: PrintHeader | ((state: PrintPreviewState) => PrintHeader);
  /**
   * Раскладка под текущий выбор. Возвращает лист и кегль, которыми окно перерисует документ:
   * без неё «Авто»-кегль в окне не обновлялся бы, и на повёрнутом листе остались бы колонки
   * от прежнего размера — оператор увидел бы обрезанную таблицу вместо подобранной заново.
   */
  plan?: (state: PrintPreviewState) => PrintPreviewPlan;
};

/** Ступени кегля в окне предпросмотра — те же, что подбирает планировщик раскладки. */
const PREVIEW_FONT_STEPS = [12, 10, 9, 8] as const;

function renderPrintHeader(header: PrintHeader): string {
  const lines = (header.lines ?? [])
    .map((line) => String(line ?? '').trim())
    .filter(Boolean)
    .map((line) => `<div class="doc-filter">${escapeHtml(line)}</div>`)
    .join('');
  const meta = String(header.meta ?? '').trim();
  return `<header class="doc-head">
  <h1>${escapeHtml(header.title)}</h1>
  ${lines}
  ${meta ? `<div class="doc-meta">${escapeHtml(meta)}</div>` : ''}
</header>`;
}

export function escapeHtml(s: string) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/** Момент для шапки листа и файла: «19.10.2026 05:12». Общий у печати и выгрузки. */
export function formatMomentLabel(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
    .doc-head { margin: 0 0 10px 0; padding-bottom: 6px; border-bottom: 1px solid #cbd5e1; }
    .doc-head h1 { font-size: 18px; margin: 0 0 4px 0; }
    .doc-filter { font-size: 11px; color: #374151; line-height: 1.45; }
    .doc-meta { font-size: 10px; color: #6b7280; margin-top: 3px; }
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
export function printSectionsDirect(opts: { title: string; sections: PrintSection[]; extraCss?: string; targetWindow?: Window | null }) {
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
  const w = opts.targetWindow ?? window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
  const imagesReady = Promise.all(
    Array.from(w.document.images).map((img) => {
      if (img.complete) return img.decode?.().catch(() => undefined) ?? Promise.resolve();
      return new Promise<void>((resolve) => {
        img.addEventListener('load', () => resolve(), { once: true });
        img.addEventListener('error', () => resolve(), { once: true });
      });
    }),
  );
  void imagesReady.then(() => setTimeout(() => {
    w.addEventListener('afterprint', () => w.close());
    w.focus();
    w.print();
  }, 100));
}

/**
 * Окно предпросмотра печати. Переключатели ориентации/кегля перерисовывают документ в
 * том же окне: `document.write` во вновь открытом окне Electron не исполняет встроенные
 * `<script>`, поэтому обработчики вешает открывающее окно, а не сам документ (иначе
 * переключатели молчали бы, а разделы застревали бы скрытыми — «пустая страница»).
 */
export function openPrintPreview(opts: PrintPreviewOptions) {
  const title = escapeHtml(opts.title);
  const subtitle = opts.subtitle ? escapeHtml(opts.subtitle) : '';
  const previewState: PrintPreviewState = {
    orientation: opts.orientation ?? 'portrait',
    fontSizePt: opts.fontSizePt ?? PREVIEW_FONT_STEPS[0],
    fontSizePinned: false,
  };
  const sectionsFor = (state: PrintPreviewState): PrintSection[] =>
    typeof opts.sections === 'function' ? opts.sections(state) : opts.sections;
  const state = {
    ...previewState,
    sections: sectionsFor(previewState).map((s) => ({ ...s })),
  };

  const visibilityCss = state.sections
    .map((s) => {
      const id = escapeHtml(s.id);
      return `body:has(input[data-section="${id}"]:not(:checked)) [data-print-section="${id}"] { display: none !important; }`;
    })
    .join('\n    ');

  // Собираются на каждую перерисовку: иначе после переключения радиокнопка «отпрыгивала» бы
  // назад к варианту, с которым окно открылось, и оператор не понял бы, что выбрано.
  const sectionControls = () =>
    state.sections
      .map((s) => {
        const checked = s.checked === false ? '' : 'checked';
        return `<label class="toggle">
  <input type="checkbox" data-section="${escapeHtml(s.id)}" ${checked}/>
  <span>${escapeHtml(s.title)}</span>
</label>`;
      })
      .join('\n');

  const orientationControls = opts.orientationSwitch
    ? () => `<span class="toggle">Лист:</span>
      <label class="toggle"><input type="radio" name="print-orientation" data-orientation="portrait" ${state.orientation === 'portrait' ? 'checked' : ''}/><span>Книжная</span></label>
      <label class="toggle"><input type="radio" name="print-orientation" data-orientation="landscape" ${state.orientation === 'landscape' ? 'checked' : ''}/><span>Альбомная</span></label>`
    : () => '';

  const fontControls = opts.fontSizeSwitch
    ? () => `<span class="toggle">Кегль:</span>${PREVIEW_FONT_STEPS.map(
        (pt) =>
          `<label class="toggle"><input type="radio" name="print-font" data-font-size="${pt}" ${state.fontSizePt === pt ? 'checked' : ''}/><span>${pt} pt</span></label>`,
      ).join('\n      ')}`
    : () => '';

  const build = () => {
    const header = typeof opts.printHeader === 'function' ? opts.printHeader(state) : opts.printHeader;
    const extraCss = typeof opts.extraCss === 'function' ? opts.extraCss(state) : opts.extraCss;
    // Отметки разделов живут в состоянии окна, а разметка приходит заново на каждую
    // перерисовку — переносим выбор оператора по id, иначе галочка гаснет молча.
    const sections = sectionsFor(state).map((s) => {
      const previous = state.sections.find((old) => old.id === s.id);
      return previous?.checked == null ? s : { ...s, checked: previous.checked };
    });
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${title}</title>
  <style>${PRINT_BASE_CSS}
    ${visibilityCss}
    @page { size: A4 ${state.orientation}; margin: ${PRINT_MARGIN_MM}mm; }
    @media print { body { margin: 0; } }
    table th, table td { font-size: ${state.fontSizePt}pt; }
    ${extraCss ?? ''}
  </style>
</head>
<body>
  <div class="no-print">
    ${header ? '' : `<h1>${title}</h1>`}
    ${header || !subtitle ? '' : `<div class="subtitle">${subtitle}</div>`}
    <div class="controls">
      ${orientationControls()}
      ${fontControls()}
      ${sectionControls()}
      <button class="action" id="printBtn">Печать / PDF</button>
    </div>
  </div>
  ${header ? renderPrintHeader(header) : ''}
  ${renderSectionsHtml(sections)}
</body>
</html>`;
  };

  const w = window.open('', '_blank');
  if (!w) return;

  // Раскладка — источник правды по листу и кеглю: пока оператор не выбрал кегль сам, его
  // подбирает раскладка под текущий лист, и переключатели обязаны показывать именно его.
  const resolvePlan = (): PrintPreviewPlan => {
    const planned = opts.plan
      ? opts.plan(state)
      : { orientation: state.orientation, fontSizePt: state.fontSizePt };
    state.orientation = planned.orientation;
    state.fontSizePt = planned.fontSizePt;
    return planned;
  };

  const draw = () => {
    resolvePlan();
    w.document.open();
    w.document.write(build());
    w.document.close();
    const doc = w.document;

    doc.querySelectorAll<HTMLInputElement>('input[data-orientation]').forEach((el) => {
      el.addEventListener('change', () => {
        if (!el.checked) return;
        state.orientation = el.dataset.orientation === 'landscape' ? 'landscape' : 'portrait';
        draw();
      });
    });
    doc.querySelectorAll<HTMLInputElement>('input[data-font-size]').forEach((el) => {
      el.addEventListener('change', () => {
        if (!el.checked) return;
        const next = Number(el.dataset.fontSize);
        if (!Number.isFinite(next) || next <= 0) return;
        state.fontSizePt = next;
        state.fontSizePinned = true;
        draw();
      });
    });
    doc.querySelectorAll<HTMLInputElement>('input[data-section]').forEach((el) => {
      el.addEventListener('change', () => {
        const id = el.dataset.section;
        const section = state.sections.find((s) => s.id === id);
        if (section) section.checked = el.checked;
      });
    });
    const printBtn = doc.getElementById('printBtn');
    if (printBtn) printBtn.addEventListener('click', () => w.print());
    w.focus();
  };

  draw();
}
