import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Передача файлов между Верстаками держится на трёх решениях, и каждое легко разобрать обратно
// «для простоты». Сторож фиксирует именно их, а не форму кода.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const SERVICE = src('./desktopTransferService.ts');
const IPC = src('../ipc/register/desktopTransfer.ts');
const APP = src('../../renderer/src/ui/App.tsx');
const BAR = src('../../renderer/src/ui/components/DesktopInboxBar.tsx');

describe('передача файлов на Верстак коллеги', () => {
  it('переслать можно только то, к чему есть доступ у самого отправителя', () => {
    // Мета берётся у сервера, и это же проверка доступа. Без неё «отправить» стало бы способом
    // раздать чужой файл: id файла оператор видит в своей же реплике.
    expect(SERVICE, 'исчезла проверка доступа отправителя').toContain('const meta = await filesMeta(');
    expect(SERVICE).toContain('if (!meta.ok) return { ok: false, error: meta.error };');
  });

  it('транспорт — личное сообщение с файлом: оно и доезжает, и выдаёт доступ получателю', () => {
    expect(SERVICE).toContain("messageType: 'file',");
    expect(SERVICE).toContain('recipientUserId,');
    // Своей таблицы нет намеренно: она потребовала бы правки контракта синхронизации и
    // отдельного источника прав — там, где ошибка стоит дороже всего.
    expect(SERVICE).not.toContain('CREATE TABLE');
  });

  it('право на отправку — то же, что на файл в чате', () => {
    expect(IPC).toContain("requirePermOrResult(ctx, 'chat.use')");
    expect(IPC, 'режим просмотра снова пишет').toContain('viewModeWriteError()');
  });

  it('ярлык кладётся только после согласия получателя', () => {
    // Приём — местное действие в СВОЁМ профиле; отправитель в чужую секцию не пишет.
    expect(APP).toContain('function acceptDesktopInbox(');
    expect(APP).toContain('desktopPutShortcut(');
    expect(BAR).toContain('Принять');
    expect(BAR).toContain('Отклонить');
  });

  it('отклонение не трогает ни файл, ни сообщение — чужое не удаляем', () => {
    expect(APP).toContain('function declineDesktopInbox(');
    const decline = APP.slice(APP.indexOf('function declineDesktopInbox('), APP.indexOf('async function sendDesktopFileTo('));
    expect(decline).not.toContain('deleteMessage');
    expect(decline).not.toContain('files.delete');
  });

  it('список входящих читается локально — предложение видно и без сети', () => {
    expect(IPC).toContain('ctx.dataDb()');
    expect(SERVICE).toContain('.from(chatMessages)');
  });
});
