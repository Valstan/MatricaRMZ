import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  WORK_ORDER_APPROVERS,
  WORK_ORDER_APPROVER_DEFAULT,
  WORK_ORDER_PRINT_FONT_DEFAULTS,
  WORK_ORDER_PRINT_FONT_RANGES,
  type WorkOrderApprover,
  type WorkOrderPrintSettings,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { SearchSelect } from './SearchSelect.js';
import {
  deleteWoPrintTemplate,
  loadWoPrintDefault,
  loadWoPrintTemplates,
  saveWoPrintDefault,
  saveWoPrintTemplate,
  type WoPrintTemplate,
} from '../utils/woPrintTemplates.js';

/** Полный лист A4 в px @96dpi. Поля (12мм) теперь внутри #wo-a4 как padding. */
const A4_WIDTH_PX = Math.round((210 * 96) / 25.4); // ≈ 794 (вся страница, 210мм)
const A4_HEIGHT_PX = Math.round((297 * 96) / 25.4); // ≈ 1123 (одна страница A4)
/** Делитель для подсчёта страниц: одна страница = вся высота A4 (поля включены в #wo-a4). */
const A4_PAGE_FULL_PX = A4_HEIGHT_PX; // ≈ 1123
/** Масштаб листа в превью (zoom — влияет на layout, в отличие от transform:scale). */
const PREVIEW_SCALE = 0.86;

function msToDateInput(ms: number | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dateInputToMs(value: string): number | undefined {
  if (!value) return undefined;
  const t = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(t) ? t : undefined;
}

const APPROVER_KEYS = Object.keys(WORK_ORDER_APPROVERS) as WorkOrderApprover[];

type FontKey = 'fontDirector' | 'fontTitle' | 'fontMeta' | 'fontCrew' | 'fontWorks' | 'fontSignatures';
const FONT_ROWS: Array<{ key: FontKey; label: string; hint?: string; range: { min: number; max: number }; def: number }> = [
  { key: 'fontDirector', label: 'Утверждаю (директор)', hint: 'гриф в верхнем углу', range: WORK_ORDER_PRINT_FONT_RANGES.director, def: WORK_ORDER_PRINT_FONT_DEFAULTS.director },
  { key: 'fontTitle', label: 'Заголовок наряда', range: WORK_ORDER_PRINT_FONT_RANGES.title, def: WORK_ORDER_PRINT_FONT_DEFAULTS.title },
  { key: 'fontMeta', label: 'Строка реквизитов', hint: '№ · дата · двигатель · заказчик', range: WORK_ORDER_PRINT_FONT_RANGES.meta, def: WORK_ORDER_PRINT_FONT_DEFAULTS.meta },
  { key: 'fontCrew', label: 'Бригада', range: WORK_ORDER_PRINT_FONT_RANGES.crew, def: WORK_ORDER_PRINT_FONT_DEFAULTS.crew },
  { key: 'fontWorks', label: 'Виды работ', range: WORK_ORDER_PRINT_FONT_RANGES.works, def: WORK_ORDER_PRINT_FONT_DEFAULTS.works },
  { key: 'fontSignatures', label: 'Подписи', range: WORK_ORDER_PRINT_FONT_RANGES.signatures, def: WORK_ORDER_PRINT_FONT_DEFAULTS.signatures },
];

function StepArrow(props: { dir: 'up' | 'down'; disabled: boolean; onPress: () => void }) {
  const { dir, disabled, onPress } = props;
  const tri: React.CSSProperties =
    dir === 'up'
      ? { borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderBottom: '6px solid currentColor' }
      : { borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '6px solid currentColor' };
  const timer = useRef<{ to?: ReturnType<typeof setTimeout>; iv?: ReturnType<typeof setInterval> }>({});
  const stop = () => {
    if (timer.current.to) clearTimeout(timer.current.to);
    if (timer.current.iv) clearInterval(timer.current.iv);
    timer.current = {};
  };
  const start = () => {
    if (disabled) return;
    onPress();
    timer.current.to = setTimeout(() => {
      timer.current.iv = setInterval(onPress, 70);
    }, 320);
  };
  // Гарантированная очистка таймеров при размонтировании (нет утечки interval).
  useEffect(() => stop, []);
  return (
    <button
      type="button"
      aria-label={dir === 'up' ? 'Больше' : 'Меньше'}
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 18,
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: disabled ? 'var(--subtle)' : 'var(--text)',
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? 'default' : 'pointer',
        touchAction: 'none',
      }}
    >
      <span style={{ width: 0, height: 0, ...tri }} />
    </button>
  );
}

function FontStepper(props: { label: string; hint?: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  const { label, hint, value, min, max, onChange } = props;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{label}</span>
        {hint ? <span style={{ fontSize: 10.5, color: 'var(--subtle)', lineHeight: 1.2 }}>{hint}</span> : null}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          height: 38,
          border: '1px solid var(--input-border)',
          borderRadius: 8,
          background: 'var(--input-bg)',
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            width: 38,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 15,
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--text)',
          }}
        >
          {value}
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--input-border)' }}>
          <StepArrow dir="up" disabled={value >= max} onPress={() => onChange(clamp(value + 1))} />
          <span style={{ height: 1, background: 'var(--input-border)' }} />
          <StepArrow dir="down" disabled={value <= min} onPress={() => onChange(clamp(value - 1))} />
        </span>
      </div>
    </div>
  );
}

export function WorkOrderPrintDialog(props: {
  settings: WorkOrderPrintSettings;
  workOrderKind: string;
  workOrderKindLabel: string;
  autoTitle: string;
  defaultDateMs: number;
  /** Кандидаты в утверждающие грифа (сотрудники): id, метка и готовое ФИО «И.О. Фамилия» для печати. */
  approverEmployees?: Array<{ id: string; label: string; grifName: string; hintText?: string }>;
  /** Строит standalone A4-HTML (с #wo-a4) для iframe-превью по заданным настройкам. */
  buildHtml: (settings: WorkOrderPrintSettings) => string;
  onChange: (settings: WorkOrderPrintSettings) => void;
  onPrint: (settings: WorkOrderPrintSettings) => void;
  onClose: () => void;
}) {
  // Родитель монтирует диалог только при открытии → draft инициализируется свежим.
  // У наряда нет своих настроек → берём умолчание для его вида (если задано оператором).
  const [draft, setDraft] = useState<WorkOrderPrintSettings>(() =>
    props.settings && Object.keys(props.settings).length ? props.settings : loadWoPrintDefault(props.workOrderKind) ?? {},
  );
  const [pages, setPages] = useState<number>(1);
  const [templates, setTemplates] = useState<WoPrintTemplate[]>(() => loadWoPrintTemplates());
  const [templateName, setTemplateName] = useState('');
  const [note, setNote] = useState('');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const html = useMemo(() => props.buildHtml(draft), [props.buildHtml, draft]);

  function applySettings(next: WorkOrderPrintSettings) {
    setDraft(next);
    props.onChange(next);
  }

  function update(patch: Partial<WorkOrderPrintSettings>) {
    applySettings({ ...draft, ...patch });
  }

  // Выбор пресета грифа сбрасывает ручные override (должность/ФИО/сотрудник) — чтобы
  // «Директор»/«Технический директор» показывали свои значения, а не залипший override.
  function selectPresetApprover(key: WorkOrderApprover) {
    const next = { ...draft, approver: key };
    delete next.approverPositionOverride;
    delete next.approverNameOverride;
    delete next.approverEmployeeId;
    applySettings(next);
  }

  // Точечная правка override: пустая строка удаляет ключ (возврат к значению пресета).
  function setApproverOverride(patch: {
    approverPositionOverride?: string | undefined;
    approverNameOverride?: string | undefined;
    approverEmployeeId?: string | undefined;
  }) {
    const next = { ...draft };
    for (const [k, v] of Object.entries(patch) as [keyof WorkOrderPrintSettings, string | undefined][]) {
      if (v) (next as Record<string, unknown>)[k] = v;
      else delete (next as Record<string, unknown>)[k];
    }
    applySettings(next);
  }

  function onSaveTemplate() {
    const name = templateName.trim();
    if (!name) return;
    setTemplates(saveWoPrintTemplate(name, draft));
    setTemplateName('');
    setNote(`Шаблон «${name}» сохранён`);
  }

  function onSaveDefault() {
    saveWoPrintDefault(props.workOrderKind, draft);
    setNote(`Умолчание для «${props.workOrderKindLabel}» сохранено`);
  }

  function measure() {
    const doc = iframeRef.current?.contentWindow?.document;
    const el = doc?.getElementById('wo-a4');
    if (!el) return;
    const h = el.scrollHeight;
    setPages(Math.max(1, Math.ceil(h / A4_PAGE_FULL_PX)));
    // Растянуть iframe под весь контент (минимум — одна страница), чтобы превью показывало всё.
    if (iframeRef.current) iframeRef.current.style.height = `${Math.max(h, A4_HEIGHT_PX) + 8}px`;
  }

  const fits = pages <= 1;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 18,
          display: 'flex',
          gap: 20,
          width: 'min(97vw, 1180px)',
          maxWidth: 'min(97vw, 1180px)',
          maxHeight: '94vh',
        }}
      >
        <div style={{ flex: '0 0 240px', width: 240, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Настройка печати наряда</div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--subtle)', marginBottom: 4 }}>Заголовок</div>
            <Input
              value={draft.titleOverride ?? ''}
              placeholder={props.autoTitle}
              onChange={(e) => update({ titleOverride: e.target.value })}
            />
          </div>

          <div style={{ display: 'grid', gap: 4 }}>
            <div style={{ fontSize: 12, color: 'var(--subtle)' }}>Печатать в шапке</div>
            {(
              [
                { key: 'hideOrderDate', label: 'Дата создания' },
                { key: 'hideStartDate', label: 'Приступить' },
                { key: 'hideDueDate', label: 'Срок' },
                { key: 'hideWorkshop', label: 'Цех' },
              ] as Array<{ key: 'hideOrderDate' | 'hideStartDate' | 'hideDueDate' | 'hideWorkshop'; label: string }>
            ).map((row) => (
              <label key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!draft[row.key]}
                  onChange={(e) => {
                    const next = { ...draft };
                    if (e.target.checked) delete next[row.key];
                    else next[row.key] = true;
                    applySettings(next);
                  }}
                />
                {row.label}
              </label>
            ))}
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--subtle)', marginBottom: 4 }}>Дата создания (на печати)</div>
            <input
              type="date"
              value={msToDateInput(draft.orderDateOverride ?? props.defaultDateMs)}
              onChange={(e) => {
                const ms = dateInputToMs(e.target.value);
                const next = { ...draft };
                if (ms !== undefined) next.orderDateOverride = ms;
                else delete next.orderDateOverride;
                setDraft(next);
                props.onChange(next);
              }}
              style={{ width: '100%', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--input-border)', background: 'var(--input-bg)', color: 'var(--text)' }}
            />
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--subtle)', marginBottom: 4 }}>Утверждаю (гриф)</div>
            <div style={{ display: 'flex', border: '1px solid var(--input-border)', borderRadius: 8, overflow: 'hidden' }}>
              {APPROVER_KEYS.map((key, i) => {
                const active = (draft.approver ?? WORK_ORDER_APPROVER_DEFAULT) === key;
                const v = WORK_ORDER_APPROVERS[key];
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => selectPresetApprover(key)}
                    title={`${v.position} — ${v.name}`}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: '7px 6px',
                      border: 'none',
                      borderLeft: i === 0 ? 'none' : '1px solid var(--input-border)',
                      background: active ? 'var(--button-primary-bg)' : 'var(--input-bg)',
                      color: active ? 'var(--button-primary-text)' : 'var(--text)',
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: active ? 700 : 400,
                      lineHeight: 1.25,
                    }}
                  >
                    {v.label}
                    <div style={{ fontSize: 10, opacity: 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.name}</div>
                  </button>
                );
              })}
            </div>
            {(() => {
              const activeKey = draft.approver ?? WORK_ORDER_APPROVER_DEFAULT;
              const preset = WORK_ORDER_APPROVERS[activeKey] ?? WORK_ORDER_APPROVERS[WORK_ORDER_APPROVER_DEFAULT];
              const emp = props.approverEmployees ?? [];
              const overridden = Boolean(
                draft.approverPositionOverride?.trim() || draft.approverNameOverride?.trim() || draft.approverEmployeeId,
              );
              return (
                <div style={{ marginTop: 6, display: 'grid', gap: 6 }}>
                  <input
                    value={draft.approverPositionOverride ?? ''}
                    onChange={(e) => setApproverOverride({ approverPositionOverride: e.target.value })}
                    placeholder={`Должность (по умолчанию: ${preset.position})`}
                    title="Своя должность утверждающего — печатается вместо пресета"
                    style={{ width: '100%', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--input-border)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 12 }}
                  />
                  <SearchSelect
                    value={draft.approverEmployeeId ?? null}
                    options={emp.map((x) => ({ id: x.id, label: x.label, ...(x.hintText ? { hintText: x.hintText } : {}) }))}
                    placeholder={`Сотрудник для ФИО (по умолчанию: ${preset.name})`}
                    onChange={(id) => {
                      const chosen = emp.find((x) => x.id === id);
                      setApproverOverride({ approverEmployeeId: chosen?.id, approverNameOverride: chosen?.grifName });
                    }}
                  />
                  {overridden ? (
                    <button
                      type="button"
                      onClick={() => selectPresetApprover(activeKey)}
                      style={{ justifySelf: 'start', fontSize: 11, color: 'var(--subtle)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
                    >
                      ↺ Вернуть к пресету «{preset.label}»
                    </button>
                  ) : null}
                </div>
              );
            })()}
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Шаблоны</div>
            {templates.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {templates.map((t) => (
                  <span
                    key={t.id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      border: '1px solid var(--input-border)',
                      borderRadius: 999,
                      background: 'var(--input-bg)',
                      overflow: 'hidden',
                    }}
                  >
                    <button
                      type="button"
                      title="Применить шаблон"
                      onClick={() => applySettings(t.settings)}
                      style={{ border: 'none', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 12, padding: '4px 8px' }}
                    >
                      {t.name}
                    </button>
                    <button
                      type="button"
                      aria-label="Удалить шаблон"
                      title="Удалить шаблон"
                      onClick={() => setTemplates(deleteWoPrintTemplate(t.id))}
                      style={{ border: 'none', background: 'transparent', color: 'var(--subtle)', cursor: 'pointer', fontSize: 14, padding: '4px 7px 4px 0' }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--subtle)' }}>Нет сохранённых шаблонов</div>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <Input value={templateName} placeholder="Имя шаблона" onChange={(e) => setTemplateName(e.target.value)} />
              <Button variant="ghost" onClick={onSaveTemplate} disabled={!templateName.trim()}>
                Сохранить
              </Button>
            </div>
            <Button variant="ghost" onClick={onSaveDefault} title="Применять эти настройки ко всем нарядам этого вида по умолчанию">
              Умолчание для «{props.workOrderKindLabel}»
            </Button>
            {note ? <div style={{ fontSize: 11, color: 'var(--success, #0f6e56)' }}>{note}</div> : null}
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'grid', gap: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Размер шрифта по разделам</div>
            {FONT_ROWS.map((row) => (
              <FontStepper
                key={row.key}
                label={row.label}
                {...(row.hint ? { hint: row.hint } : {})}
                value={(draft[row.key] as number | undefined) ?? row.def}
                min={row.range.min}
                max={row.range.max}
                onChange={(v) => update({ [row.key]: v } as Partial<WorkOrderPrintSettings>)}
              />
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto', paddingTop: 8 }}>
            <Button variant="primary" onClick={() => props.onPrint(draft)}>
              Печать / PDF
            </Button>
            <Button
              variant="ghost"
              onClick={() => applySettings(loadWoPrintDefault(props.workOrderKind) ?? {})}
              title="К умолчанию для этого вида наряда (или к встроенному, если умолчание не задано)"
            >
              Сбросить
            </Button>
            <Button variant="ghost" onClick={() => props.onClose()}>
              Закрыть
            </Button>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
          <div
            style={{
              fontSize: 12,
              padding: '4px 12px',
              borderRadius: 999,
              background: fits ? 'var(--success-bg, #e1f5ee)' : 'var(--warning-bg, #faeeda)',
              color: fits ? 'var(--success, #0f6e56)' : 'var(--warning, #854f0b)',
              whiteSpace: 'nowrap',
            }}
          >
            {fits ? '✓ Помещается на 1 лист А4' : `⚠ ${pages} страницы А4`}
          </div>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              width: '100%',
              maxHeight: '82vh',
              overflow: 'auto',
              background: '#e7e9ef',
              borderRadius: 8,
              padding: 16,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'flex-start',
            }}
          >
            {/* zoom (а не transform:scale) масштабирует и layout-бокс → скролл-контейнер
                получает реальный размер листа, без ручной подгонки высоты. Electron=Chromium. */}
            <div style={{ zoom: PREVIEW_SCALE, flex: '0 0 auto' } as React.CSSProperties}>
              <iframe
                ref={iframeRef}
                title="Предпросмотр печати наряда (A4)"
                srcDoc={html}
                onLoad={measure}
                style={{
                  width: A4_WIDTH_PX,
                  height: A4_HEIGHT_PX,
                  border: 0,
                  display: 'block',
                  background: '#fff',
                }}
              />
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--subtle)' }}>лист A4 · 210×297 мм</div>
        </div>
      </div>
    </div>
  );
}
