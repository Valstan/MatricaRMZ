export type TextSelection = { start: number; end: number } | null;

/**
 * Вставка текста кнопками «Вставить из буфера» / «Вставить из файла».
 * Вставляем в позицию курсора, а не затираем поле: оператор дописывает к тому,
 * что уже набрал. Выделенный фрагмент заменяется — как при обычной вставке.
 */
export function insertTextAtSelection(
  current: string,
  text: string,
  selection: TextSelection,
): { next: string; caret: number } {
  const base = String(current ?? '');
  const insert = String(text ?? '');
  const raw = selection ?? { start: base.length, end: base.length };
  const lo = Math.min(raw.start, raw.end);
  const hi = Math.max(raw.start, raw.end);
  // Диапазон вне текста означает, что курсора в поле нет (кнопку нажали без фокуса).
  const start = lo >= 0 && lo <= base.length ? lo : base.length;
  const end = hi >= start && hi <= base.length ? hi : base.length;
  return { next: base.slice(0, start) + insert + base.slice(end), caret: start + insert.length };
}
