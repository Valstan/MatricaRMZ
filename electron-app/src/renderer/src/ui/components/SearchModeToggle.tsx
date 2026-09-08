import React from 'react';

import type { SearchMode } from '@matricarmz/shared';

/**
 * Переключатель режима поиска рядом с полем (просьба владельца 08.09.2026).
 *
 * По умолчанию список ищет ТОЧНОЕ совпадение введённого — иначе в выдачу подмешивается
 * похожее, и «глаза разбегаются». Кнопка добавляет к результату похожее: исправление
 * раскладки, частичные совпадения слов и опечатки. Кнопка нужна на каждом списке, где
 * включён точный режим: без неё вернуть прежнее поведение было бы нечем.
 */
export function SearchModeToggle(props: { similar: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-search-similar={props.similar ? 'on' : 'off'}
      onClick={props.onToggle}
      title={
        props.similar
          ? 'Сейчас показывается и похожее: опечатки, часть слова, другая раскладка. Нажмите, чтобы искать только точные совпадения'
          : 'Сейчас только точные совпадения. Нажмите, чтобы показать ещё и похожее: опечатки, часть слова, другая раскладка'
      }
      style={{
        padding: '6px 10px',
        borderRadius: 8,
        border: '1px solid var(--border)',
        background: props.similar ? 'rgba(37, 99, 235, 0.15)' : 'var(--surface)',
        fontWeight: props.similar ? 700 : 400,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      }}
    >
      ≈ Похожие
    </button>
  );
}

/** Режим для поиска по состоянию тумблера — чтобы страницы не повторяли эту развилку. */
export function searchModeOf(similar: boolean | undefined): SearchMode {
  return similar === true ? 'similar' : 'exact';
}
