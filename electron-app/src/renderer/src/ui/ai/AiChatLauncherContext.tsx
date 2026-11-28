// ОТКРЫТИЕ ЧАТА «ИВАНЫЧА» С ВОПРОСОМ — контекст приложения.
//
// ЗАЧЕМ КОНТЕКСТ, А НЕ ПРОП. Кнопка «Нейросеть» нужна в каждом разделе (промт
// КАРМАНА #176, разрез 4), и в каждой странице тянуть проп `onOpenAiChat` — значит
// в каждой странице помнить про него. Контекст даёт одну точку: страница говорит
// «вот раздел», а как открыть чат — знает приложение.
//
// ЧТО ТУТ НЕ РЕШАЕТСЯ. Второго чата не заводим: открывается ТА ЖЕ вкладка «ИИваныч»
// (см. `openAiChatWith` в `App.tsx`), а контекст раздела едет в тексте вопроса —
// единственном поле, которое доезжает и до сервера, и до локального агента.

import React from 'react';

export type AiChatLauncher = {
  /** Открыть вкладку «ИИваныч» с готовым текстом вопроса в поле ввода. */
  openAiChat: (question: string) => void;
};

const AiChatLauncherContext = React.createContext<AiChatLauncher | null>(null);

export function AiChatLauncherProvider(props: {
  openAiChat: (question: string) => void;
  children: React.ReactNode;
}) {
  const value = React.useMemo<AiChatLauncher>(
    () => ({ openAiChat: props.openAiChat }),
    [props.openAiChat],
  );
  return <AiChatLauncherContext.Provider value={value}>{props.children}</AiChatLauncherContext.Provider>;
}

/**
 * Открыватель чата. null — приложение не дало его (страница вне провайдера):
 * тогда кнопки нет, и это молчание честнее кнопки, которая ничего не открывает.
 */
export function useAiChatLauncher(): AiChatLauncher | null {
  return React.useContext(AiChatLauncherContext);
}
