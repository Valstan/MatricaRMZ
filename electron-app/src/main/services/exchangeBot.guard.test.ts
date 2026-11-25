import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Бот обмена и пересылки держится на трёх решениях, и каждое легко разобрать
// обратно «для простоты»: клиент зовёт сервер, сервер пересылает файлом в чате,
// а доступ к файлу проверяется. Сторож фиксирует именно их, а не форму кода.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const CLIENT_SERVICE = src('./exchangeBotService.ts');
const CHAT_IPC = src('../ipc/register/chat.ts');
const TRANSFER_IPC = src('../ipc/register/desktopTransfer.ts');

describe('бот обмена и пересылки: клиентская половина', () => {
  it('бот зовётся по http-эндпойнту сервера, а не своей таблицей', () => {
    expect(CLIENT_SERVICE).toContain("'/exchange-bot/act'");
    expect(CLIENT_SERVICE, 'у бота не должно быть своей таблицы').not.toContain('CREATE TABLE');
  });

  it('вызов бота не блокирует отправку сообщения', () => {
    // Письмо оператора уже ушло; бот — улучшение, а не условие переписки.
    expect(CHAT_IPC).toContain('void notifyExchangeBot(');
    expect(TRANSFER_IPC).toContain('void notifyExchangeBot(');
  });

  it('бот знает, откуда пишет оператор: машина и версия едут с запросом', () => {
    expect(CLIENT_SERVICE).toContain('clientId');
    expect(CLIENT_SERVICE).toContain('clientName');
    expect(CLIENT_SERVICE).toContain('deviceKind');
    expect(CLIENT_SERVICE).toContain('appVersion');
  });

  it('ответ бота приходит обычным сообщением чата — отдельного канала ответа нет', () => {
    // Свой канал «ответ бота» означал бы второй транспорт и второй контракт.
    expect(CLIENT_SERVICE, 'у клиента не должно быть канала ответа бота').not.toContain('exchangeBot:reply');
  });

  it('подсказка «какой файл ждёт ответа» помнит, кому файл ушёл', () => {
    // Файл, отправленный коллеге, — не запрос боту: по нему бот пересылать не должен.
    expect(CLIENT_SERVICE).toContain('pendingFileRecipientUserId');
    expect(CLIENT_SERVICE).toContain('recipientUserId: recipient');
  });
});
