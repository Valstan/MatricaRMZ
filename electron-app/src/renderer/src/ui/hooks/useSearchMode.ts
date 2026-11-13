import { useCallback, useEffect, useState } from 'react';

import { useOnTabVisible } from '../shell/TabVisibilityContext.js';

/**
 * Режим поиска списка (владелец 13.11.2026, промты КАРМАНА #10 + #14).
 *
 * Правило одно для всех экранов: пока в поле печатают, ищется ТОЧНО — символ в символ.
 * «Похожие» (опечатки, часть слова, другая раскладка) включается кнопкой «≈ Похожие»
 * и только на то время, пока оператор её держит включённой.
 *
 * Чего режим не делает:
 * - **не переживает перезапуск списка**: панель показали снова — снова строгий;
 * - **не переживает очистку поля**: начал новый поиск — снова строгий;
 * - **не переживает сброс фильтров**: сброс возвращает строгий (это делает `reset()`);
 * - **не сохраняется на диск**: в sessionStorage его нет вообще.
 *
 * Почему не в состоянии списка: список лежит в sessionStorage (`useListUiState`), и «похожие»
 * возвращалось на следующий день и на другом экране — оператор видел «лишнее» в выдаче
 * и не понимал, откуда оно (владелец 13.11.2026: «операторы в нём путаются»).
 */
export function useSearchMode(opts?: { query?: string }) {
  const [similar, setSimilar] = useState(false);
  const query = opts?.query ?? '';

  // Новое поле — новый поиск: очистил строку, вернись к точному.
  useEffect(() => {
    if (!query.trim()) setSimilar(false);
  }, [query]);

  // Список открыли заново (вернулись на вкладку) — «похожие» не переживает перезапуск списка.
  useOnTabVisible(() => setSimilar(false));

  const toggle = useCallback(() => setSimilar((prev) => !prev), []);
  const reset = useCallback(() => setSimilar(false), []);

  return { similar, toggle, reset };
}
