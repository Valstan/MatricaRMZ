import React, { useCallback, useMemo, useState } from 'react';

import {
  parsePrintDocumentValues,
  parsePrintTemplateLayout,
  printFormKind,
  type PrintDocumentDto,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { escapeHtml, openPrintPreview, type PrintSection } from '../utils/printPreview.js';
import { buildPrintFormsA4PreviewHtml } from '../utils/printFormsPreview.js';

/**
 * Документ открыт «как он уйдёт на бумагу»: блоки печатной формы, подставленные
 * значения и снимок раскладки, зафиксированный при создании. Правка шаблона уже не
 * влияет на этот документ — он заполнен и отправлен.
 */
export function PrintDocumentPreviewDialog(props: {
  document: PrintDocumentDto;
  onClose: () => void;
}) {
  const [disabled, setDisabled] = useState<string[]>([]);

  const kind = printFormKind(props.document.entityKey);
  const values = useMemo(() => parsePrintDocumentValues(props.document.valuesJson), [props.document.valuesJson]);
  const layout = useMemo(
    () => parsePrintTemplateLayout(props.document.layoutJson),
    [props.document.layoutJson],
  );

  const sections = useMemo<PrintSection[]>(() => {
    const e = (v: unknown) => escapeHtml(String(v ?? ''));
    const from = props.document.authorUsername;
    const to = props.document.recipientUsername ?? '—';
    const content: Record<string, string> = {
      title: `<div style="text-align:center;font-size:16px;font-weight:700;">${e(props.document.title)}</div>`,
      from: `<div><b>От:</b> ${e(from)}</div>`,
      to: `<div><b>Кому:</b> ${e(to)}</div>`,
      body: `<div style="white-space:pre-wrap;">${e(values.body ?? props.document.note)}</div>`,
      employee: `<div><b>Сотрудник:</b> ${e(from)}</div>`,
      period: `<div><b>Период:</b> ${e(values.period ?? '')}</div>`,
      reason: `<div><b>Причина:</b> ${e(values.reason ?? '')}</div>`,
      sign: `<div style="margin-top:18px;">
  <div>Подпись: ______________________ (${e(from)})</div>
  <div style="margin-top:10px;">Получил: ______________________ (${e(to)})</div>
</div>`,
    };
    const defs = kind?.sections ?? [];
    return defs
      .filter((s) => !disabled.includes(s.id))
      .map((s) => ({
        id: s.id,
        title: s.title,
        html: content[s.id] ?? `<div class="muted">Нет данных</div>`,
        hideTitle: s.id === 'title',
      }));
  }, [kind, values, props.document, disabled]);

  const previewHtml = useMemo(
    () => buildPrintFormsA4PreviewHtml({ sections, ...(layout.images?.length ? { images: layout.images } : {}) }),
    [sections, layout.images],
  );

  const doPrint = useCallback(() => {
    openPrintPreview({ title: 'Документ', sections });
  }, [sections]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: 'var(--surface, #fff)',
          borderRadius: 8,
          padding: 14,
          width: 'min(1000px, 95vw)',
          height: 'min(86vh, 880px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <strong>{props.document.title}</strong>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Button onClick={props.onClose}>Закрыть</Button>
            <Button onClick={doPrint}>Печать / PDF</Button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, flex: '1 1 auto', minHeight: 0 }}>
          <div style={{ width: 220, overflow: 'auto', flex: '0 0 auto' }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Пункты формы</div>
            {(kind?.sections ?? []).map((s) => (
              <label
                key={s.id}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 4 }}
              >
                <input
                  type="checkbox"
                  checked={!disabled.includes(s.id)}
                  onChange={(e) =>
                    setDisabled((prev) =>
                      e.target.checked ? prev.filter((x) => x !== s.id) : [...prev, s.id],
                    )
                  }
                />
                {s.title}
              </label>
            ))}
          </div>
          <iframe
            title="Предпросмотр документа"
            srcDoc={previewHtml}
            style={{ flex: '1 1 auto', border: '1px solid var(--border, #e5e7eb)', borderRadius: 6, background: '#e7e9ef' }}
          />
        </div>
      </div>
    </div>
  );
}
