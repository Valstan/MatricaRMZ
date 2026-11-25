import { SyncTableName } from '@matricarmz/shared';

/**
 * Строки, которые сервер УЖЕ ПРИНЯЛ — их нельзя возвращать в очередь.
 *
 * Что было (инцидент PC63, 17–25.11.2026): клиент отправляет строку, сервер её
 * принимает, но содержимое совпадает с тем, что на сервере уже лежит (no-op) ⇒
 * строка не попадает в журнал, её номер (`last_server_seq`) не меняется ⇒ pull
 * никогда её не привезёт ⇒ у клиента она навсегда остаётся «synced без номера».
 * Самолечение `requeueUnconfirmedRows` (M52) считает такую строку «отправленной,
 * но не подтверждённой» и возвращает в `pending` — по кругу, без конца: строка
 * висела в очереди неделю, аларм «очередь застряла» не умолкал, при этом данные
 * на сервере были (и оставались) верными.
 *
 * Что здесь: память о строках, которые сервер подтвердил (ответ `applied_rows`).
 * Подтверждение — прямое доказательство, что строка на сервере есть; возвращать
 * её в очередь незачем. Память живёт только в сессии клиента и ограничена по
 * времени и размеру: после перезапуска клиента строки подтверждаются заново.
 */

/** Сколько живёт подтверждение. Дальше строка считается «не подтверждённой» — как и раньше. */
const CONFIRMED_TTL_MS = 6 * 60 * 60_000;

/** Потолок на таблицу: больше не держим. Подтверждённое старше TTL и так выпадает. */
const MAX_CONFIRMED_PER_TABLE = 20_000;

export class ConfirmedRows {
  private byTable = new Map<SyncTableName, Map<string, number>>();

  /** Запомнить строки, которые сервер подтвердил (ответ push). */
  remember(table: SyncTableName, ids: readonly string[], now: number = Date.now()): void {
    const list = (ids ?? []).map((id) => String(id ?? '')).filter(Boolean);
    if (list.length === 0) return;
    let bucket = this.byTable.get(table);
    if (!bucket) {
      bucket = new Map<string, number>();
      this.byTable.set(table, bucket);
    }
    for (const id of list) bucket.set(id, now);
    this.prune(table, now);
  }

  /** Подтверждена ли строка сервером (и не протухло ли подтверждение). */
  isConfirmed(table: SyncTableName, id: string, now: number = Date.now()): boolean {
    const bucket = this.byTable.get(table);
    if (!bucket) return false;
    const at = bucket.get(String(id ?? ''));
    if (at == null) return false;
    if (now - at > CONFIRMED_TTL_MS) {
      bucket.delete(String(id ?? ''));
      return false;
    }
    return true;
  }

  /** Забыть подтверждение (строку переписали — старое подтверждение не в счёт). */
  forget(table: SyncTableName, id: string): void {
    this.byTable.get(table)?.delete(String(id ?? ''));
  }

  /** Чистка: протухшие и лишние. */
  private prune(table: SyncTableName, now: number): void {
    const bucket = this.byTable.get(table);
    if (!bucket) return;
    for (const [id, at] of bucket) {
      if (now - at > CONFIRMED_TTL_MS) bucket.delete(id);
    }
    while (bucket.size > MAX_CONFIRMED_PER_TABLE) {
      const oldest = bucket.keys().next();
      if (oldest.done) break;
      bucket.delete(oldest.value);
    }
  }
}

/** Память клиента на эту сессию. */
export const confirmedRows = new ConfirmedRows();
