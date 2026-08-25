import React, { createContext, useContext } from 'react';

import type { DesktopFileShortcut } from '@matricarmz/shared';

/**
 * Файловые ярлыки Рабочего стола — для карточек.
 *
 * Контекст, а не проп: панель вложений рендерится из девяти страниц-карточек, а стол живёт
 * состоянием в App. Протаскивать проп через девять страниц — значит завести девять мест,
 * где его можно забыть.
 *
 * Направление важно. Не стол пишет в карточку, а карточка БЕРЁТ со стола и кладёт файл
 * своим обычным механизмом: у контрагента, сотрудника и инструмента список вложений живёт
 * в памяти открытой карточки и уходит в БД снимком при её закрытии, поэтому запись
 * «снаружи» потерялась бы молча.
 */
const DesktopFilesContext = createContext<ReadonlyArray<DesktopFileShortcut>>([]);

export function DesktopFilesProvider(props: { value: ReadonlyArray<DesktopFileShortcut>; children: React.ReactNode }) {
  return <DesktopFilesContext.Provider value={props.value}>{props.children}</DesktopFilesContext.Provider>;
}

/** Пусто — значит стола нет (планшет) или на нём нет файлов; кнопку «взять» не показываем. */
export function useDesktopFiles(): ReadonlyArray<DesktopFileShortcut> {
  return useContext(DesktopFilesContext);
}
