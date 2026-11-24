import { describe, expect, it } from 'vitest';

import { SyncTableName, SyncTableRegistry } from '@matricarmz/shared';

import { aiChatRequests } from '../database/schema.js';

// Источник ответа — это то, чем клиент доказывает серверу, кто посчитал ответ
// (D-243/D-244). Push клиента собирается общим toSyncRow по реестру sync: реестр
// берёт поле из строки реплики по ИМЕНИ. Если имя в реплике разойдётся с
// реестром, источник молча уезжает на сервер пустым — сервер такой ответ
// отвергает, и локальный ответ оператора теряется.
//
// Этот тест — страховка от такой расхождения имён: сверяем не текст, а сами
// поля схемы и реестра.

describe('push источника ответа ИИваныча', () => {
  it('имена полей реестра есть в клиентской реплике', () => {
    const entry = SyncTableRegistry.get(SyncTableName.AiChatRequests);
    expect(entry).toBeTruthy();
    const columns = new Set(Object.keys(aiChatRequests));
    const missing = entry!.fields.map((f) => f.db).filter((name) => !columns.has(name));
    expect(missing).toEqual([]);
  });

  it('ответ локального звена уезжает на сервер вместе с источником', () => {
    const dto = SyncTableRegistry.toSyncRow(SyncTableName.AiChatRequests, {
      id: 'q1',
      userId: 'u1',
      username: 'ivan',
      questionText: 'почему станок молчит?',
      status: 'answered',
      answerText: 'ответ локального агента',
      answeredAt: 1,
      answerSource: 'local_minimax',
    });
    expect(dto.status).toBe('answered');
    expect(dto.answer_text).toBe('ответ локального агента');
    expect(dto.answer_source).toBe('local_minimax');
  });

  it('резерв с машины тоже помечается своим источником', () => {
    const dto = SyncTableRegistry.toSyncRow(SyncTableName.AiChatRequests, {
      id: 'q2',
      userId: 'u1',
      username: 'ivan',
      questionText: 'вопрос',
      status: 'answered',
      answerText: 'ответ',
      answeredAt: 2,
      answerSource: 'deepseek_client',
    });
    expect(dto.answer_source).toBe('deepseek_client');
  });
});
