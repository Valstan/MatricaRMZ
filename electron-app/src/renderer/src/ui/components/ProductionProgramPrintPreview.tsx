import React, { useMemo, useRef, useState } from 'react';

import {
  PRODUCTION_PROGRAM_SIGNATURE_SLOTS,
  resolveProductionProgramSignatureSlots,
  type ProductionProgramPrintInput,
  type ProductionProgramSignatureSlot,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { SignatureSlotsEditor, type SignatureSlotRow } from './SignatureSlotsEditor.js';
import { productionProgramPrintHtml } from '../utils/productionProgramPrintHtml.js';

/**
 * Превью печатной формы производственной программы (владелец 10.11.2026).
 *
 * Проблема, которую снимает окно: кнопка «Печать» сразу открывала системный диалог
 * принтера — оператор не мог ни посмотреть форму, ни поправить её (закрытие окна
 * принтера закрывало и форму). Теперь между «Печать» и принтером есть промежуточный
 * этап: форма показана как будет на бумаге, и её можно настроить:
 *  · **состав подписей** — блок подписей редактируется прямо здесь: должность,
 *    человек (из кадрового реестра) или ФИО от руки, добавление и удаление строк
 *    (владелец 23.11.2026: «открыли производственную программу на печать, и там
 *    надо добавить ещё одну подпись, а мы не можем, никак»);
 *  · **галочки «печать»** — снятая строка просто не попадает на лист (это вид печати,
 *    а не состав документа);
 *  · **кегли разделов** — шапка, список строк и подписи размером independently;
 *  · **кнопка «Печать»** отправляет на принтер именно то, что видно в превью.
 *
 * Что остаётся видом печати, а что — данными документа:
 *  · кегли и галочки «печать» — **вид печати** (живут в окне, в программу не пишутся);
 *  · **состав подписей** — **данные программы** (уходят в программу и в выгрузку
 *    файлом): кто подписывает лист — это часть документа, а не настройка принтера.
 */

/** A4 landscape в пикселях при 96 dpi — размер iframe с документом. */
const PAGE_WIDTH_PX = 1123;
const PAGE_HEIGHT_PX = 794;
/** Масштаб превью: лист целиком в окно, дальше — прокрутка. */
const PREVIEW_SCALE = 0.62;

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 24;

/** Подсказки должностей в редакторе подписей — роли из образца печатной формы. */
const CAPTION_SUGGESTIONS = PRODUCTION_PROGRAM_SIGNATURE_SLOTS.map((slot) => slot.caption);

/** Строка блока подписей → доменный слот (в программу и в печать идёт без ключа строки). */
function toSlot(row: SignatureSlotRow): ProductionProgramSignatureSlot {
  return {
    caption: row.caption,
    employeeId: row.employeeId,
    fullName: row.fullName,
  };
}

/**
 * Строки блока подписей на старте окна.
 *
 * Ключ строки — только для интерфейса: по нему форма помнит, какую строку печатать,
 * когда должность переписали или строки переставили (должность для этого не годится —
 * она меняется при правке).
 */
function initialRows(slots: readonly ProductionProgramSignatureSlot[]): SignatureSlotRow[] {
  return slots.map((slot, index) => ({
    id: `slot-${index}`,
    caption: slot.caption,
    employeeId: slot.employeeId ?? null,
    fullName: slot.fullName ?? '',
  }));
}

export function ProductionProgramPrintPreview(props: {
  input: ProductionProgramPrintInput;
  onClose: () => void;
  /** Можно ли править состав подписей (право вести план). */
  canEditSignatures?: boolean;
  /**
   * Состав подписей программы (данные программы).
   *
   * null/undefined — блок не трогали: в форме образцовый набор строк.
   */
  signatureSlots?: readonly ProductionProgramSignatureSlot[] | null;
  /** Состав изменили — сохранить в программе. */
  onSignatureSlotsChange?: (slots: ProductionProgramSignatureSlot[]) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [headerFontSize, setHeaderFontSize] = useState(14);
  const [tableFontSize, setTableFontSize] = useState(14);
  const [signatureFontSize, setSignatureFontSize] = useState(14);

  // Состав подписей — состояние окна: набор строк программы. Ключи строк — свои,
  // чтобы «печатать / не печатать» не путалось при правке должности или перестановке.
  const [rows, setRows] = useState<SignatureSlotRow[]>(() =>
    initialRows(props.signatureSlots ?? resolveProductionProgramSignatureSlots(null)),
  );
  const [printedIds, setPrintedIds] = useState<string[]>(() =>
    initialRows(props.signatureSlots ?? resolveProductionProgramSignatureSlots(null)).map((row) => row.id),
  );

  const employees = props.input.employees ?? [];

  const changeRows = (next: SignatureSlotRow[]) => {
    setRows(next);
    props.onSignatureSlotsChange?.(next.map(toSlot));
  };

  const togglePrinted = (id: string) => {
    setPrintedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  // На лист идут ТОЛЬКО отмеченные строки: снятая подпись не печатается. Состав
  // (все строки) уходит в программу и в выгрузку файлом — это разные вещи.
  const printedSlots = useMemo(
    () => rows.filter((row) => printedIds.includes(row.id)).map(toSlot),
    [rows, printedIds],
  );

  const html = useMemo(
    () =>
      productionProgramPrintHtml(
        { ...props.input, signatureSlots: printedSlots },
        {
          headerFontSize,
          tableFontSize,
          signatureFontSize,
        },
      ),
    [props.input, printedSlots, headerFontSize, tableFontSize, signatureFontSize],
  );

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

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)', minHeight: 0, flex: 1 }}>
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
                Должность и человек — своими словами. Снимите галочку — подпись не попадёт на печать.
              </span>
              <SignatureSlotsEditor
                rows={rows}
                canEdit={props.canEditSignatures === true}
                employees={employees}
                rankKey="employee:production-program-signature"
                onChange={changeRows}
                captionSuggestions={CAPTION_SUGGESTIONS}
                datalistId="pp-signature-captions"
                addLabel="+ Добавить подпись"
                hint={
                  props.canEditSignatures === true
                    ? 'Состав подписей сохраняется в программе — он печатается и в файле выгрузки.'
                    : 'Состав подписей задаёт тот, кто ведёт план.'
                }
                renderExtra={(row) => (
                  <input
                    type="checkbox"
                    checked={printedIds.includes(row.id)}
                    onChange={() => togglePrinted(row.id)}
                    title="Печатать эту подпись"
                    style={{ marginTop: 2 }}
                  />
                )}
              />
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
