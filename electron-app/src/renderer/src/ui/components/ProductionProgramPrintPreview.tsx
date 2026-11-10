import React, { useMemo, useRef, useState } from 'react';

import { buildProductionProgramPrintModel, type ProductionProgramPrintInput } from '@matricarmz/shared';

import { Button } from './Button.js';
import { productionProgramPrintHtml } from '../utils/productionProgramPrintHtml.js';

/**
 * Превью печатной формы производственной программы (владелец 10.11.2026).
 *
 * Проблема, которую снимает окно: кнопка «Печать» сразу открывала системный диалог
 * принтера — оператор не мог ни посмотреть форму, ни поправить её (закрытие окна
 * принтера закрывало и форму). Теперь между «Печать» и принтером есть промежуточный
 * этап: форма показана как будет на бумаге, и её можно настроить:
 *  · галочки у подписей — ненужная подпись убирается из печати;
 *  · кегли разделов — шапка, список строк и подписи размером independently;
 *  · кнопка «Печать» отправляет на принтер именно то, что видно в превью.
 *
 * Настройки живут в состоянии окна: это вид печати, а не данные плана — в саму
 * программу они не пишутся.
 */

/** A4 landscape в пикселях при 96 dpi — размер iframe с документом. */
const PAGE_WIDTH_PX = 1123;
const PAGE_HEIGHT_PX = 794;
/** Масштаб превью: лист целиком в окно, дальше — прокрутка. */
const PREVIEW_SCALE = 0.62;

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 24;

export function ProductionProgramPrintPreview(props: { input: ProductionProgramPrintInput; onClose: () => void }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [headerFontSize, setHeaderFontSize] = useState(14);
  const [tableFontSize, setTableFontSize] = useState(14);
  const [signatureFontSize, setSignatureFontSize] = useState(14);

  // Подписи модели — список для галочек. Снятая подпись просто не печатается.
  const allSignatures = useMemo(() => buildProductionProgramPrintModel(props.input).signatures, [props.input]);
  const [enabledCaptions, setEnabledCaptions] = useState<string[]>(() => allSignatures.map((s) => s.caption));

  const html = useMemo(
    () =>
      productionProgramPrintHtml(props.input, {
        headerFontSize,
        tableFontSize,
        signatureFontSize,
        signatureCaptions: enabledCaptions,
      }),
    [props.input, headerFontSize, tableFontSize, signatureFontSize, enabledCaptions],
  );

  const toggleSignature = (caption: string) => {
    setEnabledCaptions((prev) => (prev.includes(caption) ? prev.filter((c) => c !== caption) : [...prev, caption]));
  };

  const stepFont = (setter: (next: number) => void, value: number, delta: number) => {
    setter(Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, value + delta)));
  };

  const fontRow = (label: string, value: number, onChange: (next: number) => void) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
      <span style={{ fontSize: 13 }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Button variant="ghost" onClick={() => stepFont(onChange, value, -1)} title="Уменьшить кегль">
          −
        </Button>
        <span style={{ minWidth: 46, textAlign: 'center', fontSize: 13 }}>{value} pt</span>
        <Button variant="ghost" onClick={() => stepFont(onChange, value, 1)} title="Увеличить кегль">
          +
        </Button>
      </span>
    </div>
  );

  return (
    <div
      data-pp-print-preview
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        style={{
          width: 'min(1180px, 97vw)',
          height: 'min(860px, 95vh)',
          background: 'var(--surface)',
          borderRadius: 12,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <strong style={{ fontSize: 14 }}>Печатная форма — предпросмотр</strong>
          <span style={{ flex: 1 }} />
          <Button
            variant="primary"
            data-pp-print-preview-print
            onClick={() => {
              const frame = iframeRef.current?.contentWindow;
              if (!frame) return;
              frame.focus();
              frame.print();
            }}
          >
            Печать
          </Button>
          <Button variant="ghost" onClick={props.onClose}>
            Закрыть
          </Button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 300px) minmax(0, 1fr)', minHeight: 0, flex: 1 }}>
          <div style={{ borderRight: '1px solid var(--border)', overflow: 'auto', padding: 12, display: 'grid', gap: 14, alignContent: 'start' }}>
            <div style={{ display: 'grid', gap: 8 }}>
              <strong style={{ fontSize: 13 }}>Размеры шрифта</strong>
              {fontRow('Шапка', headerFontSize, setHeaderFontSize)}
              {fontRow('Список двигателей', tableFontSize, setTableFontSize)}
              {fontRow('Подписи', signatureFontSize, setSignatureFontSize)}
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <strong style={{ fontSize: 13 }}>Подписи</strong>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>
                Снимите галочку — подпись не попадёт на печать.
              </span>
              {allSignatures.map((s) => (
                <label key={s.caption} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={enabledCaptions.includes(s.caption)}
                    onChange={() => toggleSignature(s.caption)}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    <span style={{ display: 'block' }}>{s.caption}</span>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--subtle)' }}>{s.name}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div style={{ overflow: 'auto', padding: 12, background: 'var(--surface-sunken, #f8fafc)' }}>
            <div
              style={{
                width: PAGE_WIDTH_PX * PREVIEW_SCALE,
                height: PAGE_HEIGHT_PX * PREVIEW_SCALE,
                overflow: 'hidden',
                boxShadow: '0 2px 12px rgba(15, 23, 42, 0.25)',
                background: '#fff',
              }}
            >
              <iframe
                ref={iframeRef}
                title="Предпросмотр печатной формы"
                srcDoc={html}
                style={{
                  width: PAGE_WIDTH_PX,
                  height: PAGE_HEIGHT_PX,
                  border: 'none',
                  transform: `scale(${PREVIEW_SCALE})`,
                  transformOrigin: 'top left',
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
