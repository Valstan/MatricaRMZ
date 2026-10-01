import { labelEmoji } from '@matricarmz/shared';

/**
 * `data-emoji` для подписи: значок рисует CSS (`::before`), а сам текст подписи
 * не меняется — точные совпадения в тестах, CDP-драйверах и поиске целы.
 * Не нашлось значка — атрибут не ставится вовсе, подпись как была.
 */
export function emojiAttrs(label: string): { 'data-emoji'?: string } {
  const emoji = labelEmoji(label);
  return emoji ? { 'data-emoji': emoji } : {};
}
