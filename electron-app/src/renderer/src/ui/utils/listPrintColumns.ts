import React from 'react';

import type { ListPrintColumn } from '../components/ListPrintDialog.js';

/**
 * Колонка списка глазами печати. Списки описывают ячейку как `render` → ReactNode, печати же
 * нужен текст. Заводить второй, «печатный» список колонок на каждой странице — гарантированный
 * дрейф: он уже случился (у двигателей набор полей печати жил отдельно и расходился с
 * колонками). Поэтому источник один, а текст берётся из того же `render`.
 */
export type PrintableListColumn<T> = {
  id: string;
  label: string;
  render: (row: T) => React.ReactNode;
  /** Явный текст для ячейки, если из разметки он получается плохим. */
  printValue?: (row: T) => string;
  /** Колонка не имеет текстового смысла (миниатюры, кнопки) — в печать не предлагается. */
  printSkip?: boolean;
};

/**
 * Собирает текст из отрендеренной ячейки. Обходит только разметку: вложенный компонент
 * отрисовать здесь нельзя, и такая ячейка даёт пустую строку — для этого у колонки есть
 * `printSkip`, чтобы пустая колонка не попадала в диалог молча.
 */
export function reactNodeToText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactNodeToText).join(' ');
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode } | undefined;
    return reactNodeToText(props?.children);
  }
  return '';
}

function normalize(text: string): string {
  // Прочерк-заглушка списка в печатной таблице не нужен: там своя.
  const value = text.replace(/\s+/g, ' ').trim();
  return value === '-' || value === '—' ? '' : value;
}

export function buildListPrintColumns<T>(columns: PrintableListColumn<T>[]): ListPrintColumn<T>[] {
  return columns
    .filter((c) => !c.printSkip)
    .map((c) => ({
      id: c.id,
      label: c.label,
      printValue: (row: T) => normalize(c.printValue ? c.printValue(row) : reactNodeToText(c.render(row))),
    }));
}
