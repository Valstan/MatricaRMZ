import { describe, expect, it } from 'vitest';

import { traceUnhandledBotUpdate } from '../services/syncPipelineSupervisorService.js';

const ADMIN = 'owner_tg';

describe('след от обновлений, которые бот не обработал', () => {
  it('сообщение не от суперадмина — след с чатом и отправителем, без текста', () => {
    const trace = traceUnhandledBotUpdate(
      {
        update_id: 1,
        message: { text: '/sync_chat_id', chat: { id: -100500, type: 'group' }, from: { username: 'Somebody' } },
      },
      ADMIN,
    );

    expect(trace).toEqual({ kind: 'ignored_sender', chatId: -100500, chatType: 'group', fromUsername: '@somebody' });
    expect(JSON.stringify(trace)).not.toContain('sync_chat_id');
  });

  it('отправитель без имени пользователя — тоже след, имя пустое', () => {
    const trace = traceUnhandledBotUpdate(
      { update_id: 2, message: { text: 'привет', chat: { id: 42, type: 'private' }, from: { first_name: 'Без ника' } } },
      ADMIN,
    );

    expect(trace).toEqual({ kind: 'ignored_sender', chatId: 42, chatType: 'private', fromUsername: null });
  });

  it('контроль: сообщение суперадмина следа не оставляет — его обработает команда', () => {
    const trace = traceUnhandledBotUpdate(
      { update_id: 3, message: { text: '/sync_status', chat: { id: 42, type: 'private' }, from: { username: '@Owner_TG' } } },
      ADMIN,
    );

    expect(trace).toBeNull();
  });

  it('бота добавили в группу или убрали — след с номером чата и новым статусом', () => {
    const trace = traceUnhandledBotUpdate(
      {
        update_id: 4,
        my_chat_member: {
          chat: { id: -100777, type: 'supergroup' },
          from: { username: 'owner_tg' },
          new_chat_member: { status: 'administrator' },
        },
      },
      ADMIN,
    );

    expect(trace).toEqual({ kind: 'membership', chatId: -100777, chatType: 'supergroup', status: 'administrator' });
  });

  it('кнопки и обновления без чата следа не оставляют', () => {
    expect(traceUnhandledBotUpdate({ update_id: 5, callback_query: { id: 'cb', from: { username: 'x' } } }, ADMIN)).toBeNull();
    expect(traceUnhandledBotUpdate({ update_id: 6, message: { text: 'x', from: { username: 'x' } } }, ADMIN)).toBeNull();
  });
});
