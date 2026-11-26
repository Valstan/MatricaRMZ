import { useCallback, useEffect, useState } from 'react';

import type { GlobalSearchKind } from '@matricarmz/shared';

import { useOnTabVisible } from '../shell/TabVisibilityContext.js';

/**
 * Выбор поля поиска — кнопка «где искать» (владелец 25.11.2026, промт КАРМАНА #138).
 *
 * Отдельный переключатель от РЕЖИМА поиска («точный» / «≈ Похожие»): режим отвечает на
 * вопрос «как строго искать», выбор поля — «где искать». Одно не должно ломать другое,
 * поэтому здесь своё состояние и свои правила жизни.
 *
 * Чего выбор поля НЕ делает (как и режим — правило одно на оба переключателя):
 * - **не переживает перезапуск списка**: панель показали снова — снова «искать везде»;
 * - **не переживает очистку поля**: начал новый поиск — снова «искать везде»;
 * - **не сохраняется на диск**: в sessionStorage его нет вовсе.
 *
 * Почему так: выбор поля привязан к полям СТРОКИ. Перенести его на другой список —
 * значит искать по полю, которого там нет, и получить пустую выдачу; оператор решит,
 * что поиск сломан. Поэтому перенос запрещён, а сброс ВИДЕН: кнопка показывает
 * «Искать везде», и в подсказке сказано, что выбор держится, пока вы на этом списке.
 *
 * Поле действует только в своей сущности: чужой выбор (другая сущность) не применяется
 * — иначе выдача молча пустеет.
 */
export type SearchFieldChoice = { kind: GlobalSearchKind; fieldId: string };

export function useSearchField(opts?: { kind?: GlobalSearchKind; query?: string }) {
  const [choice, setChoice] = useState<SearchFieldChoice | null>(null);
  const query = opts?.query ?? '';
  const kind = opts?.kind;

  // Новое поле — новый поиск: очистил строку, вернись к «искать везде».
  useEffect(() => {
    if (!query.trim()) setChoice(null);
  }, [query]);

  // Список открыли заново (вернулись на вкладку) — выбор поля не переносится.
  useOnTabVisible(() => setChoice(null));

  // Сменилась сущность — поля другие, переносить нечего.
  useEffect(() => {
    setChoice((prev) => (prev && prev.kind === kind ? prev : null));
  }, [kind]);

  const select = useCallback((next: SearchFieldChoice | null) => setChoice(next), []);
  const clear = useCallback(() => setChoice(null), []);

  // Чужое поле не применяется: пустая выдача молча — худший ответ.
  const fieldId = choice && choice.kind === kind ? choice.fieldId : null;

  return { choice, fieldId, select, clear };
}
