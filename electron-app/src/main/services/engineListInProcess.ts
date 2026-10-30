// Сборка списка двигателей в своём процессе — и общий тип источника.
//
// Модуль отдельный от `engineListSource` намеренно: тот тянет `dataProxy` (Electron
// `utilityProcess`), а планшету отдельный процесс недоступен вовсе — шим `electron` его
// не реализует. Здесь нет ни одного electron-импорта, поэтому android-бандл берёт
// отсюда, не затягивая за собой десктопный пульт.
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { EngineListItem } from '@matricarmz/shared';

import { listEngines, warmEngineListCaches } from './engineService.js';

export type EngineListRead = {
  rows: EngineListItem[];
  phases: Record<string, number>;
  ms: number;
};

export type EngineListSource = {
  /** true — список собирает отдельный процесс, главный поток в это время свободен. */
  readonly outOfProcess: boolean;
  /** Никогда не бросает из-за воркера: не смог — собрали здесь. */
  read: () => Promise<EngineListRead>;
  /**
   * Собрать здесь и сейчас, не спрашивая воркер. Нужно режиму просмотра копии базы:
   * воркер держит соединение с ЖИВОЙ базой, а копия живёт только в этом процессе.
   */
  readHere: () => Promise<EngineListRead>;
  warm: () => void;
  dispose: () => void;
};

export type InProcessEngineListArgs = {
  /**
   * Соединение этого процесса. Функция, а не значение: в режиме просмотра копии
   * (`backup`) читается другая база, и откат обязан идти в неё, а не в живую.
   */
  db: () => BetterSQLite3Database;
};

/**
 * Источник, который собирает список в своём процессе. Нужен там, где отдельного
 * процесса нет вовсе (планшет) или где он не поднялся (откат десктопа).
 */
export function createInProcessEngineListSource(args: InProcessEngineListArgs): EngineListSource {
  const read = async (): Promise<EngineListRead> => {
    const phases: Record<string, number> = {};
    const startedAt = Date.now();
    const rows = await listEngines(args.db(), {
      onPhase: (phase, ms) => {
        phases[phase] = Math.round(ms);
      },
    });
    return { rows, phases, ms: Date.now() - startedAt };
  };
  return {
    outOfProcess: false,
    read,
    readHere: read,
    // Best-effort: ошибка прогрева не должна ломать открытие списка — кэш построит вызов.
    warm: () => {
      void warmEngineListCaches(args.db()).catch(() => undefined);
    },
    dispose: () => {},
  };
}
