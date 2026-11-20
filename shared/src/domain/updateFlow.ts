// ЧТО КЛИЕНТ ДЕЛАЕТ С ОБНОВЛЕНИЕМ — ОДНО ПРАВИЛО ДЛЯ ВСЕХ (владелец 21.11.2026:
// «у меня стоит 136 версия и не обновляется на следующие»).
//
// Разобрано на живой машине парка: обновление 3.137.0 было скачано и лежало
// отложенным (`pending-update.json`), а клиент — ПОКА ОТЛОЖЕННОЕ СУЩЕСТВУЕТ —
// переставал искать более новую версию вообще. Про следующий релиз (3.138.0) он
// не узнавал никогда, пока оператор не нажмёт «Перезапуск». Парк целиком стоял на
// старых версиях по той же причине: обновление «зависло» на одном шаге.
//
// Отсюда правило: ОТЛОЖЕННОЕ ОБНОВЛЕНИЕ НЕ ИМЕЕТ ПРАВА ГЛУШИТЬ БОЛЕЕ НОВОЕ.
//
// Действия (их разбирает клиент, решает здесь домен):
//   offer-pending   — отложенное новее установленного и ничем не заменено: предлагаем его;
//   discard-pending — отложенное устарело (сервер знает более новую) или уже не нужно:
//                     выкидываем, дальше качаем свежее;
//   download-newer  — отложенного нет, сервер отдаёт более новую версию: качаем;
//   none            — обновлений нет.
//
// Сравнение версий — эпохо-зависимое (`compareAppVersion`): клиент на старой нумерации
// должен понимать, что 3.138.0 новее его 2026.714.1503, а не наоборот.

import { compareAppVersion } from './appVersion.js';

export type UpdateFlowAction = 'offer-pending' | 'discard-pending' | 'download-newer' | 'none';

export function chooseUpdateFlow(args: {
  /** Версия, которая сейчас установлена и запущена. */
  currentVersion: string;
  /** Версия отложенного обновления (`pending-update.json`), если оно есть. */
  pendingVersion?: string | null;
  /** Версия, которую отдал сервер (последний известный релиз), если он ответил. */
  serverVersion?: string | null;
}): UpdateFlowAction {
  const current = String(args.currentVersion ?? '').trim();
  const pending = String(args.pendingVersion ?? '').trim();
  const server = String(args.serverVersion ?? '').trim();

  if (pending) {
    const pendingIsNewer = compareAppVersion(pending, current) > 0;
    if (!pendingIsNewer) {
      // Отложенное уже не нужно: программа на нём или новее — файл устарел.
      return 'discard-pending';
    }
    // Сервер знает более новую версию → отложенное устарело, оно больше не «готово».
    if (server && compareAppVersion(server, pending) > 0) return 'discard-pending';
    return 'offer-pending';
  }

  if (server && compareAppVersion(server, current) > 0) return 'download-newer';
  return 'none';
}

/**
 * Человеческая подпись «обновление ждёт нажатия» — для кнопки «Перезапуск» и плашки.
 * Версию подставляет вызывающий (уже готовая «Матрица3-РМЗ (138)»).
 */
export function formatUpdateReadyNotice(args: { versionLabel?: string | null }): string {
  const label = String(args.versionLabel ?? '').trim();
  return label
    ? `Вышло обновление ${label} — нажмите «Перезапуск» в шапке, когда закончите работу.`
    : 'Вышло обновление — нажмите «Перезапуск» в шапке, когда закончите работу.';
}
