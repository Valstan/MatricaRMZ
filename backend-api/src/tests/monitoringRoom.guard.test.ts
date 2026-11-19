import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Сторож «аларм доезжает до администратора».
 *
 * Две беды, каждая тихая:
 *   - тревога пишется в личку и прокручивается (её не видно, когда она нужна);
 *   - комната заведена, но не опубликована в журнал синка — и её нет ни у кого на
 *     клиенте: строка без номера журнала не видна pull'у.
 */
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const ALERT = src('../services/stuckPendingAlertService.ts');
const CHAT = src('../services/chatMessageService.ts');
const INDEX = src('../index.ts');

describe('аларм доезжает до администратора', () => {
  it('тревога падает в комнату «Мониторинг завода», а не теряется в личке', () => {
    expect(ALERT).toContain('ensureMonitoringRoom');
    expect(ALERT).toContain('postChatMessageToRoom');
    // Личное письмо остаётся запасным путём (нет супер-админа — пишем хоть куда-то).
    expect(ALERT).toContain('postChatMessageToSuperadmin');
  });

  it('комната заводится сервером и публикуется через журнал синка', () => {
    expect(CHAT).toContain('MONITORING_ROOM_TITLE');
    expect(CHAT).toContain('SyncTableName.ChatRooms');
    expect(CHAT).toContain('recordSyncChanges');
    // Сообщение в комнате адресуется комнате, а не человеку.
    expect(CHAT).toContain('room_id: roomId');
  });

  it('комната заводится при старте сервера — в неё можно позвать заместителя до аварии', () => {
    expect(INDEX).toContain('ensureMonitoringRoom');
  });
});
