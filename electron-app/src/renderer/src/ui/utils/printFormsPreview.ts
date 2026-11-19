/**
 * Живой предпросмотр печатной формы по шаблону: лист A4 с картинками шаблона.
 *
 * Отдельная функция, а не правка `buildWorkOrderA4PreviewHtml`: наряд и табель
 * печатают без картинок, а печатная форма — с ними (эмблема, печать, схема).
 * Картинка вшита в шаблон как data URI — в окне печати нет доступа к файлам.
 */
import {
  PRINT_IMAGE_PLACEMENT_TITLES,
  type PrintTemplateImage,
} from '@matricarmz/shared';

import { PRINT_BASE_CSS, type PrintSection } from './printPreview.js';

function escapeAttr(value: string): string {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function imageHtml(image: PrintTemplateImage): string {
  const width = image.widthMm && image.widthMm > 0 ? image.widthMm : 60;
  const caption = image.caption?.trim()
    ? `<div class="pt-img-cap">${escapeAttr(image.caption)}</div>`
    : '';
  return `<figure class="pt-img" style="width:${width}mm">
  <img src="${escapeAttr(image.dataUri)}" alt="${escapeAttr(image.caption || 'Картинка формы')}" />
  ${caption}
</figure>`;
}

/** Картинки шаблона: сверху/снизу — блоком, слева/справа — колонкой у листа. */
export function buildTemplateImagesHtml(
  images: readonly PrintTemplateImage[] | undefined,
  side: 'left' | 'right',
): string {
  const list = (images ?? []).filter((img) => img.placement === side);
  if (list.length === 0) return '';
  return `<div class="pt-images pt-images-${side}">${list.map(imageHtml).join('')}</div>`;
}

export function buildTemplateImagesBlock(
  images: readonly PrintTemplateImage[] | undefined,
  placement: 'top' | 'bottom',
): string {
  const list = (images ?? []).filter((img) => img.placement === placement);
  if (list.length === 0) return '';
  return `<div class="pt-images pt-images-${placement}">${list.map(imageHtml).join('')}</div>`;
}

/**
 * Лист A4 с формой и картинками шаблона — для iframe-предпросмотра в окне печати.
 * Разметка листа повторяет `buildWorkOrderA4PreviewHtml`, чтобы предпросмотр и
 * реальная печать не расходились.
 */
export function buildPrintFormsA4PreviewHtml(opts: {
  sections: PrintSection[];
  extraCss?: string;
  landscape?: boolean;
  marginMm?: number;
  images?: readonly PrintTemplateImage[];
}): string {
  const w = opts.landscape ? 297 : 210;
  const h = opts.landscape ? 210 : 297;
  const m = opts.marginMm ?? 12;
  const content = opts.sections
    .map((s) => {
      const html = s.html?.trim() ? s.html : '<div class="muted">Нет данных</div>';
      const heading = s.hideTitle ? '' : `<h2>${s.title}</h2>`;
      return `<section class="section" data-print-section="${escapeAttr(s.id)}">
  ${heading}
  ${html}
</section>`;
    })
    .join('\n');
  const top = buildTemplateImagesBlock(opts.images, 'top');
  const bottom = buildTemplateImagesBlock(opts.images, 'bottom');
  const left = buildTemplateImagesHtml(opts.images, 'left');
  const right = buildTemplateImagesHtml(opts.images, 'right');
  const imageCss = `
    .pt-images { display: flex; gap: 6mm; align-items: flex-start; }
    .pt-images-top { justify-content: center; margin-bottom: 6mm; }
    .pt-images-bottom { justify-content: center; margin-top: 6mm; }
    .pt-images-left, .pt-images-right { flex-direction: column; }
    .pt-img { margin: 0; }
    .pt-img img { width: 100%; height: auto; display: block; }
    .pt-img-cap { font-size: 8pt; color: #6b7280; text-align: center; margin-top: 1mm; }`;
  const body =
    left || right
      ? `<div class="pt-body">${left}<div class="pt-main">${top}${content}${bottom}</div>${right}</div>`
      : `${top}${content}${bottom}`;
  return `<!doctype html><html><head><meta charset="utf-8"/><style>${PRINT_BASE_CSS}
    html, body { margin: 0; background: #e7e9ef; }
    #wo-a4 {
      box-sizing: border-box;
      width: ${w}mm;
      min-height: ${h}mm;
      padding: ${m}mm;
      margin: 0 auto;
      background: #fff;
      box-shadow: 0 1px 8px rgba(15,23,42,0.20);
    }
    .pt-body { display: flex; gap: 5mm; align-items: flex-start; }
    .pt-main { flex: 1 1 auto; min-width: 0; }
    ${imageCss}
    ${opts.extraCss ?? ''}
  </style></head><body><div id="wo-a4">${body}</div></body></html>`;
}

/** Подпись к размещению картинки — для подсказки в редакторе. */
export function printImagePlacementTitle(placement: string): string {
  return PRINT_IMAGE_PLACEMENT_TITLES[placement as keyof typeof PRINT_IMAGE_PLACEMENT_TITLES] ?? placement;
}
