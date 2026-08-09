// Политика keep-alive панелей оболочки v3 — чистая функция, чтобы решение можно было
// загейтить тестом: jsdom/RTL в репозитории нет, компонент оболочки тестами не покрыт.
//
// Карточки НЕ keep-alive никогда: dirty-guard построен на ЕДИНСТВЕННОЙ смонтированной
// карточке (один cardCloseActionsRef на приложение), две смонтированные карточки молча
// сломали бы «Сохранить» в диалоге закрытия.
//
// «Настройки» тоже вне списка: страница держит два интервала (30с/60с) вообще без гейта
// по видимости окна — не будить её дешевле, чем чинить ради редко используемого экрана.

import type { MatricaPlatform } from '../platform.js';

export type TabPaneKind = 'menu' | 'list' | 'card' | 'chat' | 'ai_chat' | 'settings';

export const KEEP_ALIVE_KINDS: readonly TabPaneKind[] = ['list', 'chat', 'ai_chat'];

/** На Android — полный single-mount: память WebView планшета не замерена (пункт R4b). */
export function shouldKeepAliveTab(platform: MatricaPlatform, kind: TabPaneKind): boolean {
  if (platform === 'android') return false;
  return KEEP_ALIVE_KINDS.includes(kind);
}
