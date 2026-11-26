// Каналы общего прогресса поиска (промт КАРМАНА #166).
//
// Здесь только УПРАВЛЕНИЕ прогрессом: отмена поиска и запрос текущих состояний
// (окно могло открыться посреди операции). Сами события прогресса летят в окна
// событием (`search:progress`) из `services/searchProgress.ts` — по образцу
// `sync:progress`.

import { ipcMain } from 'electron';

import { cancelSearchProgress, listSearchProgress } from '../../services/searchProgress.js';

export function registerSearchProgressIpc(_ctx: unknown) {
  /**
   * Отмена поиска: работа действительно прекращается, а не прячется результат.
   *
   * Поиск сам проверяет сигнал отмены и отдаёт частичный результат.
   */
  ipcMain.handle('search:cancel', async (_e, args?: { searchId?: string }) => {
    const searchId = String(args?.searchId ?? '').trim();
    if (!searchId) return { ok: false as const, error: 'Не указан поиск' };
    const cancelled = cancelSearchProgress(searchId);
    return { ok: true as const, cancelled };
  });

  /** Текущие состояния поисков — окно, открывшееся посреди операции. */
  ipcMain.handle('search:progress:list', async () => {
    return { ok: true as const, events: listSearchProgress() };
  });
}
