import React, { useRef, useState } from 'react';

import { normalizeLookupCompact } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { SectionCard } from './SectionCard.js';
import { SearchSelect } from './SearchSelect.js';
import { AutoGrowTextarea } from './AutoGrowTextarea.js';
import { insertTextAtSelection } from '../utils/insertText.js';

/**
 * Вкладка «Рекламация» карточки двигателя (план reclamation-tab-redesign-2026-08).
 *
 * Состояние живёт в КАРТОЧКЕ, а не здесь: панели вкладок не размонтируются (скрытие
 * через `hidden`), и от этого зависят сохранение при закрытии, черновики и печать.
 * Компонент — только разметка и жесты.
 */
export type ReclamationDraft = {
  flag: boolean;
  acceptedDate: string;
  defectDescription: string;
  actualDefect: string;
  defectNature: string;
  actNumber: string;
  actDate: string;
  shippedDate: string;
  comment: string;
};

export function EngineReclamationTab(props: {
  visible: boolean;
  canEdit: boolean;
  readOnlyNote: React.ReactNode;
  value: ReclamationDraft;
  onPatch: (patch: Partial<ReclamationDraft>) => void;
  natureOptions: string[];
  onNotice: (text: string) => void;
  attachmentsSlot: React.ReactNode;
}) {
  const { value, canEdit } = props;
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
  const actualDefectRef = useRef<HTMLTextAreaElement | null>(null);
  const [addingNature, setAddingNature] = useState(false);
  const [newNature, setNewNature] = useState('');

  const row = (label: string, control: React.ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 220px) 1fr', gap: 8, alignItems: 'center' }}>
      <div style={{ color: 'var(--subtle)' }}>{label}</div>
      {control}
    </div>
  );

  const blockRow = (label: string, control: React.ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 220px) 1fr', gap: 8, alignItems: 'start' }}>
      <div style={{ color: 'var(--subtle)', paddingTop: 6 }}>{label}</div>
      {control}
    </div>
  );

  const dateInput = (v: string, set: (next: string) => void, title: string, tag: string) => (
    <Input
      type="date"
      value={v}
      disabled={!canEdit}
      style={{ maxWidth: '22ch' }}
      title={title}
      data-recl-field={tag}
      onChange={(e) => set(e.target.value)}
    />
  );

  async function pasteInto(
    ref: React.MutableRefObject<HTMLTextAreaElement | null>,
    current: string,
    apply: (next: string) => void,
    source: 'clipboard' | 'file',
  ) {
    const el = ref.current;
    const selection = el ? { start: el.selectionStart, end: el.selectionEnd } : null;
    const r =
      source === 'clipboard'
        ? await window.matrica.files.clipboardText()
        : await window.matrica.files.pickText();
    if (!r.ok) {
      // Отмена диалога — не ошибка, молчим.
      if (r.error !== 'cancelled') props.onNotice(r.error);
      return;
    }
    const { next, caret } = insertTextAtSelection(current, r.text, selection);
    apply(next);
    // Курсор ставим после вставленного куска, чтобы оператор продолжил печатать оттуда.
    window.setTimeout(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(caret, caret);
    }, 0);
  }

  const pasteButtons = (
    ref: React.MutableRefObject<HTMLTextAreaElement | null>,
    current: string,
    apply: (next: string) => void,
    tag: string,
  ) =>
    canEdit ? (
      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
        <Button
          variant="ghost"
          data-recl-action={`${tag}-clipboard`}
          title="Вставить в это поле текст, скопированный в буфер обмена"
          onClick={() => void pasteInto(ref, current, apply, 'clipboard')}
        >
          Вставить текст из буфера
        </Button>
        <Button
          variant="ghost"
          data-recl-action={`${tag}-file`}
          title="Взять текст из файла .txt или .docx"
          onClick={() => void pasteInto(ref, current, apply, 'file')}
        >
          Вставить текст из файла
        </Button>
      </div>
    ) : null;

  function commitNewNature() {
    const label = newNature.trim();
    if (!label) return;
    const key = normalizeLookupCompact(label);
    const existing = props.natureOptions.find((o) => normalizeLookupCompact(o) === key);
    if (existing) {
      // Не плодим «Производственый» рядом с «Производственный» — подставляем найденное.
      props.onPatch({ defectNature: existing });
      props.onNotice(`Такой характер дефекта уже есть: ${existing}`);
    } else {
      props.onPatch({ defectNature: label });
    }
    setNewNature('');
    setAddingNature(false);
  }

  if (!props.value.flag) {
    return (
      <SectionCard style={{ padding: 16, background: 'rgba(37, 99, 235, 0.06)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <div style={{ color: 'var(--subtle)', fontSize: 13 }}>Двигатель не принят по рекламации.</div>
          {canEdit ? (
            <Button
              data-recl-action="accept"
              onClick={() =>
                props.onPatch({
                  flag: true,
                  ...(value.acceptedDate ? {} : { acceptedDate: new Date().toISOString().slice(0, 10) }),
                })
              }
              title="Пометить двигатель рекламационным: синяя точка в списке, поля цикла рекламации"
            >
              Принять по рекламации
            </Button>
          ) : (
            props.readOnlyNote
          )}
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard style={{ padding: 16, background: 'rgba(37, 99, 235, 0.06)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {row(
          'Дата приёмки по рекламации',
          dateInput(value.acceptedDate, (v) => props.onPatch({ acceptedDate: v }), 'Когда двигатель принят по рекламации', 'accepted-date'),
        )}

        {blockRow(
          'Описание дефекта изделия',
          <div>
            {pasteButtons(descriptionRef, value.defectDescription, (v) => props.onPatch({ defectDescription: v }), 'description')}
            <AutoGrowTextarea
              value={value.defectDescription}
              onChange={(v) => props.onPatch({ defectDescription: v })}
              visible={props.visible}
              disabled={!canEdit}
              placeholder="Что заявил заказчик и что видно на изделии"
              inputRef={descriptionRef}
              dataTag="description"
            />
          </div>,
        )}

        {blockRow(
          'Фактически установленный дефект',
          <div>
            {pasteButtons(actualDefectRef, value.actualDefect, (v) => props.onPatch({ actualDefect: v }), 'actual-defect')}
            <AutoGrowTextarea
              value={value.actualDefect}
              onChange={(v) => props.onPatch({ actualDefect: v })}
              visible={props.visible}
              disabled={!canEdit}
              placeholder="Что установили при разборе"
              inputRef={actualDefectRef}
              dataTag="actual-defect"
            />
          </div>,
        )}

        {row(
          'Установленный характер дефекта',
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 260, flex: '1 1 260px' }} data-recl-field="defect-nature">
              <SearchSelect
                value={value.defectNature || null}
                options={props.natureOptions.map((label) => ({ id: label, label }))}
                disabled={!canEdit}
                showAllWhenEmpty
                placeholder="— не установлен —"
                onChange={(next) => props.onPatch({ defectNature: next ?? '' })}
              />
            </div>
            {canEdit && !addingNature ? (
              <Button
                variant="ghost"
                data-recl-action="add-nature"
                title="Добавить в список свой характер дефекта"
                onClick={() => setAddingNature(true)}
              >
                Добавить новый характер дефекта
              </Button>
            ) : null}
            {canEdit && addingNature ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Input
                  autoFocus
                  value={newNature}
                  placeholder="Название характера дефекта"
                  data-recl-field="new-nature"
                  style={{ maxWidth: '32ch' }}
                  onChange={(e) => setNewNature(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitNewNature();
                    if (e.key === 'Escape') {
                      setNewNature('');
                      setAddingNature(false);
                    }
                  }}
                />
                <Button data-recl-action="add-nature-commit" onClick={commitNewNature}>
                  Добавить
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setNewNature('');
                    setAddingNature(false);
                  }}
                >
                  Отмена
                </Button>
              </div>
            ) : null}
          </div>,
        )}

        {row(
          'Номер акта исследования',
          <Input
            value={value.actNumber}
            disabled={!canEdit}
            style={{ maxWidth: '32ch' }}
            placeholder="Например, 14/26"
            data-recl-field="act-number"
            onChange={(e) => props.onPatch({ actNumber: e.target.value })}
          />,
        )}

        {row(
          'Дата акта исследования',
          dateInput(value.actDate, (v) => props.onPatch({ actDate: v }), 'Дата акта исследования', 'act-date'),
        )}

        {row(
          'Дата отправки заказчику',
          dateInput(value.shippedDate, (v) => props.onPatch({ shippedDate: v }), 'Когда двигатель отправлен заказчику после рекламации', 'shipped-date'),
        )}

        {blockRow(
          'Комментарий',
          <AutoGrowTextarea
            value={value.comment}
            onChange={(v) => props.onPatch({ comment: v })}
            visible={props.visible}
            disabled={!canEdit}
            placeholder="Что было и чем всё закончилось"
            minRows={4}
            dataTag="comment"
          />,
        )}

        <div data-recl-field="attachments">{props.attachmentsSlot}</div>

        {canEdit ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Button
              variant="ghost"
              data-recl-action="drop-flag"
              onClick={() => props.onPatch({ flag: false })}
              title="Снять метку «рекламационный» (поля цикла сохраняются в данных, синяя точка исчезнет)"
            >
              Снять метку рекламации
            </Button>
            <span style={{ color: 'var(--subtle)', fontSize: 12 }}>
              Поля сохраняются одним действием при закрытии карточки, файлы — сразу.
            </span>
          </div>
        ) : (
          props.readOnlyNote
        )}
      </div>
    </SectionCard>
  );
}
