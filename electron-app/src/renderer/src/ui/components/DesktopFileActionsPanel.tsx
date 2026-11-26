import React from 'react';

import { Button } from './Button.js';
import { PopupLayer } from './PopupLayer.js';

// Панель действий над выделенными на Верстаке файлами.
//
// Живёт в портале (`PopupLayer`), а не внутри панели Верстака: действие «перенести в папку»
// и «отправить по почте» открывают системные окна, и меню, запертое в контексте наложения
// предка (липкая шапка, вкладка), уехало бы под интерфейс — ровно тот класс, который закрыт
// гейтом `popupLayer.guard.test.ts`.
//
// Панель — НЕ меню: это набор кнопок, как строка групповых действий в панели вложений.
// Поэтому она инлайновая по смыслу, но рисуется порталом, чтобы ни один контекст наложения
// предка не мог её утащить под себя.

export type DesktopFileActionsPanelProps = {
  /** Прямоугольник полотна Верстака в координатах окна — панель встаёт у его низа. */
  paneRect: { left: number; top: number; width: number; height: number } | null;
  /** Сколько файлов выделено. */
  count: number;
  /** Есть ли на этой машине диск и почта (на планшете — нет). */
  canUseDisk: boolean;
  /** Идёт операция — кнопки блокируются. */
  busy: boolean;
  onAttach: () => void;
  onCopy: () => void;
  onMove: () => void;
  onSendColleague: () => void;
  onSendMail: () => void;
  onRemoveShortcuts: () => void;
};

export function DesktopFileActionsPanel(props: DesktopFileActionsPanelProps) {
  const rect = props.paneRect;
  if (!rect || props.count <= 0) return null;

  const width = Math.max(240, rect.width - 32);
  const left = rect.left + 16;
  // Панель стоит у НИЗА полотна, но ВНУТРИ окна.
  //
  // Раньше она считалась как «низ полотна + 12», то есть УЖЕ ПОД полотном. На живом
  // клиенте (живая приёмка 26.11.2026) низ полотна — это 1019 px при высоте окна
  // 1025 px, и панель уезжала на 1031 px — ЗА нижний край окна: оператор выделял
  // файлы и НИЧЕГО не видел (в DOM кнопки были, клик по ним срабатывал — но глазу
  // панели не досталось). Привязка идёт к нижней кромке полотна (`bottom`), и
  // полоса загрузки, которая поднимается над панелью (`bottom: 68`), остаётся над ней.
  const bottom = Math.max(8, window.innerHeight - (rect.top + rect.height) + 8);

  return (
    <PopupLayer>
      <div
        data-desktop-file-actions
        style={{
          position: 'fixed',
          left,
          bottom,
          width,
          display: 'flex',
          // Одна строка: высота панели постоянна, и элементы под ней (корзина, полоса загрузки)
          // знают, насколько им подняться. Перенос на вторую строку ломал бы эту договорённость.
          flexWrap: 'nowrap',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          overflowX: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 12,
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-md, 0 10px 30px rgba(2, 6, 23, 0.25))',
        }}
      >
        <strong style={{ fontSize: 13, whiteSpace: 'nowrap' }}>Файлов: {props.count}</strong>
        <Button variant="ghost" disabled={props.busy} onClick={props.onAttach}>
          📎 Прикрепить…
        </Button>
        {props.canUseDisk ? (
          <>
            <Button variant="ghost" disabled={props.busy} onClick={props.onCopy}>
              💾 Копировать…
            </Button>
            <Button variant="ghost" disabled={props.busy} onClick={props.onMove}>
              📦 Перенести…
            </Button>
          </>
        ) : null}
        <Button variant="ghost" disabled={props.busy} onClick={props.onSendColleague}>
          📤 Коллеге…
        </Button>
        {props.canUseDisk ? (
          <Button variant="ghost" disabled={props.busy} onClick={props.onSendMail}>
            ✉️ Почта…
          </Button>
        ) : null}
        <Button
          variant="ghost"
          disabled={props.busy}
          onClick={props.onRemoveShortcuts}
          title="Убрать выделенные ярлыки с Верстака (сами файлы останутся)"
        >
          🗑 Убрать
        </Button>
        {!props.canUseDisk ? (
          <span style={{ fontSize: 12, color: 'var(--subtle)', whiteSpace: 'nowrap' }}>
            На планшете файлы не копируются на диск — доступна отправка коллеге.
          </span>
        ) : null}
      </div>
    </PopupLayer>
  );
}
