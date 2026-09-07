import { describe, expect, it } from 'vitest';

import {
  DESKTOP_MAX_INBOX_HANDLED,
  desktopMarkInboxHandled,
  desktopPendingInbox,
  sanitizeDesktopSection,
  type UserUiProfileDesktop,
} from './desktop.js';

// Передача файлов между Верстаками (просьба владельца 07.09.2026): файл прилетает предложением,
// и оператор сам говорит «принять». Без согласия чужой Верстак заваливался бы плитками, а
// разбирать их пришлось бы по одной.
const base: UserUiProfileDesktop = {
  shortcuts: [],
  folders: [],
  layout: { chatPct: 33, peoplePct: 30 },
};

const incoming = [
  { messageId: 'm1', fileName: 'Акт.pdf' },
  { messageId: 'm2', fileName: 'Скан.jpg' },
  { messageId: 'm3', fileName: 'Норма.xlsx' },
];

describe('входящие файлы Верстака', () => {
  it('пока ничего не разобрано — предлагается всё', () => {
    expect(desktopPendingInbox(base, incoming).map((x) => x.messageId)).toEqual(['m1', 'm2', 'm3']);
  });

  it('принятое не предлагается снова', () => {
    const after = desktopMarkInboxHandled(base, ['m1', 'm2']);
    expect(desktopPendingInbox(after, incoming).map((x) => x.messageId)).toEqual(['m3']);
  });

  it('отклонённое тоже уходит из списка: для предложения «нет» — такой же ответ, как «да»', () => {
    const after = desktopMarkInboxHandled(base, ['m3']);
    expect(desktopPendingInbox(after, incoming).map((x) => x.messageId)).toEqual(['m1', 'm2']);
  });

  it('отметка роумится — на второй машине те же файлы не предложатся заново', () => {
    // Это и есть смысл хранить список в секции профиля, а не в памяти клиента: секция уезжает
    // на сервер и приезжает на другую машину, иначе «принять» там положило бы дубли.
    const after = desktopMarkInboxHandled(base, ['m1']);
    const roundTripped = sanitizeDesktopSection(JSON.parse(JSON.stringify(after)));
    expect(roundTripped?.inboxHandledIds).toEqual(['m1']);
    expect(desktopPendingInbox(roundTripped!, incoming).map((x) => x.messageId)).toEqual(['m2', 'm3']);
  });

  it('повторная отметка не растит список', () => {
    const once = desktopMarkInboxHandled(base, ['m1']);
    const twice = desktopMarkInboxHandled(once, ['m1']);
    expect(twice.inboxHandledIds).toEqual(['m1']);
  });

  it('пустая отметка — тождество: лишней записи профиля не будет', () => {
    expect(desktopMarkInboxHandled(base, [])).toBe(base);
  });

  it('список подрезается: он защита от повтора, а не архив переписки', () => {
    const many = Array.from({ length: DESKTOP_MAX_INBOX_HANDLED + 50 }, (_, i) => `m${i}`);
    const after = desktopMarkInboxHandled(base, many);
    expect(after.inboxHandledIds?.length).toBe(DESKTOP_MAX_INBOX_HANDLED);
    // Подрезаем с головы — самые свежие предложения важнее самых старых.
    expect(after.inboxHandledIds?.at(-1)).toBe(`m${DESKTOP_MAX_INBOX_HANDLED + 49}`);
  });
});
