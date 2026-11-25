import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Правило бота обмена и пересылки держится на четырёх решениях (промт КАРМАНА #143):
//   1. Транспорт пересылки — личное сообщение чата с файлом (своей таблицы нет).
//   2. Доступ к файлу проверяется: бот не обходит проверку отправителя.
//   3. У бота есть свой предел (антифлуд).
//   4. Бот пишет в переписку от имени бота, а не от имени оператора.
// Сторож фиксирует именно их, а не форму кода.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const BOT = src('../services/exchangeBotService.ts');
const DOMAIN = src('../../../shared/src/domain/exchangeBot.ts');

describe('бот обмена и пересылки: серверное правило', () => {
  it('транспорт — личное сообщение чата с файлом, своей таблицы нет', () => {
    expect(BOT).toContain("messageType: 'file'");
    expect(BOT, 'у бота не должно быть своей таблицы').not.toContain('CREATE TABLE');
    expect(BOT, 'у бота не должно быть своей миграции').not.toContain('pgTable(');
  });

  it('доступ отправителя к файлу проверяется до пересылки', () => {
    expect(BOT).toContain('canAccessFile(');
    expect(BOT).toContain('доступ к файлу запрещён');
  });

  it('у бота есть свой предел на флуд', () => {
    expect(BOT).toContain('FLOOD_MAX_PER_WINDOW');
    expect(BOT).toContain('floodBlocked(');
  });

  it('бот пишет от своего имени, а не от имени оператора', () => {
    expect(BOT).toContain('EXCHANGE_BOT_USERNAME');
    expect(DOMAIN).toContain("EXCHANGE_BOT_USERNAME = 'Бот обмена'");
  });

  it('отказ попадает в журнал критических событий, а успех — в обычный лог', () => {
    // Успешная пересылка — не «критическое событие»: в журнал критического она бы
    // уехала в Telegram и в МАКС и завалила бы администратора.
    expect(BOT).toContain('ingestClientCriticalEvent(');
    expect(BOT).toContain("logInfo('exchange bot");
  });
});
