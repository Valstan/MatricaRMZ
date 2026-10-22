import { app } from 'electron';

import {
  AI_ANSWER_SOURCE_LABEL,
  isLocalEngineBreakerOpen,
  type AiEngineBreaker,
  type AiEngineMode,
} from '@matricarmz/shared';

import { getLocalEngineLogTail, getLocalEngineStatus, engineFreeSpaceMb, type LocalEngineStatus } from './localAiEngine.js';

/**
 * Диагностический отчёт по локальному движку Ииваныча.
 *
 * Это ответ на «у Сапегина не заработало»: версия клиента, версия и путь
 * движка, свободное место, код ошибки и последние строки лога — всё, что нужно,
 * чтобы понять причину без доступа к машине. Отчёт копируется в буфер одним
 * нажатием и уходит владельцу текстом.
 */

const MODE_LABEL: Record<AiEngineMode, string> = {
  auto: 'Авто (этот ПК, иначе сервер)',
  local: 'Только этот ПК',
  prod: 'Только сервер',
};

export type EngineDiagnostic = {
  report: string;
  state: string;
  version: string | null;
  dir: string | null;
  error: string | null;
};

export async function buildEngineDiagnostic(mode: AiEngineMode, breaker?: AiEngineBreaker): Promise<EngineDiagnostic> {
  const status: LocalEngineStatus = getLocalEngineStatus();
  const freeMb = await engineFreeSpaceMb(status.dir ?? undefined);
  const log = getLocalEngineLogTail();
  const lines: string[] = [];
  lines.push('ИИваныч — отчёт о локальном движке');
  lines.push(`Дата: ${new Date().toLocaleString('ru-RU')}`);
  lines.push(`Клиент: ${app.getVersion()}`);
  lines.push(`Режим: ${MODE_LABEL[mode]}`);
  lines.push(`Состояние: ${status.state}`);
  lines.push(`Версия движка: ${status.version ?? 'не установлена'}`);
  lines.push(`Каталог: ${status.dir ?? '—'}`);
  lines.push(`Порт: ${status.port ?? '—'}`);
  lines.push(`Свободно на диске: ${freeMb == null ? 'не удалось определить' : `${freeMb} МБ`}`);
  lines.push(`Рекомендованная версия: ${status.recommended ?? 'сервер не ответил'}`);
  if (status.checkedAt) lines.push(`Проверка обновлений: ${new Date(status.checkedAt).toLocaleString('ru-RU')}`);
  if (breaker) {
    const open = isLocalEngineBreakerOpen(breaker);
    lines.push(`Breaker: ${breaker.failures} неудач подряд${open ? ' — локальный на паузе' : ''}`);
  }
  if (status.error) lines.push(`Ошибка: ${status.error}`);
  if (log.length > 0) {
    lines.push('Последние строки лога движка:');
    for (const line of log.slice(-20)) lines.push(`  ${line}`);
  } else {
    lines.push('Лог движка: пусто (движок не стартовал или ничего не писал)');
  }
  return {
    report: lines.join('\n'),
    state: status.state,
    version: status.version,
    dir: status.dir,
    error: status.error,
  };
}

/** Подпись источника ответа для оператора: где посчитали. */
export function answerSourceLabel(source: 'local' | 'server' | null): string | null {
  if (!source) return null;
  return AI_ANSWER_SOURCE_LABEL[source];
}
