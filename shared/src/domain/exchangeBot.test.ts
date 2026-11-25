import { describe, expect, it } from 'vitest';

import {
  buildExchangeBotQuestion,
  buildExchangeBotSentText,
  exchangeDeviceKind,
  exchangeDeviceWord,
  parseExchangeBotChoice,
  pickExchangeBotCandidate,
  sortExchangeBotCandidates,
  type ExchangeMachineCandidate,
} from './exchangeBot.js';

function candidate(over: Partial<ExchangeMachineCandidate> = {}): ExchangeMachineCandidate {
  return {
    clientId: 'PC1-uuid',
    machineName: 'PC1',
    deviceKind: 'computer',
    login: 'operator1',
    userName: 'Иванов И. И.',
    userId: 'u-1',
    isCurrent: false,
    isOwn: false,
    lastSeenAt: 1_000,
    ...over,
  };
}

describe('тип машины', () => {
  it('компьютер, планшет и телефон различаются', () => {
    expect(exchangeDeviceKind('computer')).toBe('computer');
    expect(exchangeDeviceKind('tablet')).toBe('tablet');
    expect(exchangeDeviceKind('phone')).toBe('phone');
    expect(exchangeDeviceKind('что-то ещё')).toBe('other');
    expect(exchangeDeviceKind(null)).toBe('other');
  });

  it('называется словом, а не кодом', () => {
    expect(exchangeDeviceWord('computer')).toBe('компьютер');
    expect(exchangeDeviceWord('tablet')).toBe('планшет');
    expect(exchangeDeviceWord('phone')).toBe('телефон');
  });
});

describe('ответ оператора', () => {
  it('читается только голое число', () => {
    expect(parseExchangeBotChoice('1')).toBe(1);
    expect(parseExchangeBotChoice(' 12 ')).toBe(12);
    expect(parseExchangeBotChoice('0')).toBeNull();
    expect(parseExchangeBotChoice('да')).toBeNull();
    expect(parseExchangeBotChoice('1 файл')).toBeNull();
    expect(parseExchangeBotChoice('')).toBeNull();
  });

  it('выбор берёт получателя из списка', () => {
    const list = [candidate({ machineName: 'PC1' }), candidate({ machineName: 'PC2', clientId: 'PC2' })];
    expect(pickExchangeBotCandidate(list, 2)?.machineName).toBe('PC2');
    expect(pickExchangeBotCandidate(list, 3)).toBeNull();
    expect(pickExchangeBotCandidate(list, null)).toBeNull();
  });
});

describe('вопрос бота', () => {
  it('называет, где отправитель, и предлагает список', () => {
    const text = buildExchangeBotQuestion({
      senderName: 'Иванов И. И.',
      currentMachine: { machineName: 'SAMSUNG-TAB', deviceKind: 'tablet' },
      candidates: [candidate({ isOwn: true }), candidate({ machineName: 'PC2', clientId: 'PC2', userName: 'Петров П. П.', userId: 'u-2', login: 'operator2' })],
      fileName: 'акт.pdf',
    });
    expect(text).toContain('вы на планшет SAMSUNG-TAB');
    expect(text).toContain('Файл «акт.pdf»');
    expect(text).toContain('1) компьютер PC1 — Иванов И. И. — (вы)');
    expect(text).toContain('2) компьютер PC2 — Петров П. П.');
    expect(text).toContain('Ответьте номером');
  });

  it('без кандидатов говорит прямо, а не молчит', () => {
    const text = buildExchangeBotQuestion({ currentMachine: { machineName: 'PC1', deviceKind: 'computer' }, candidates: [] });
    expect(text).toContain('не нашёл');
  });
});

describe('подтверждение отправки', () => {
  it('называет получателя и его машину', () => {
    const text = buildExchangeBotSentText({
      fileName: 'акт.pdf',
      recipientName: 'Петров П. П.',
      machineName: 'PC2',
      deviceKind: 'computer',
      senderName: 'Иванов И. И.',
    });
    expect(text).toContain('Файл «акт.pdf» от Иванов И. И. переслан Петров П. П.');
    expect(text).toContain('на компьютер PC2');
  });
});

describe('порядок машин', () => {
  it('свои машины идут первыми — это получатель по умолчанию', () => {
    const list = [
      candidate({ machineName: 'PC-CHUŽ', isOwn: false, lastSeenAt: 9_000 }),
      candidate({ machineName: 'PC-MINE', isOwn: true, lastSeenAt: 1_000 }),
    ];
    expect(sortExchangeBotCandidates(list).map((c) => c.machineName)).toEqual(['PC-MINE', 'PC-CHUŽ']);
  });

  it('внутри — по свежести связи', () => {
    const list = [
      candidate({ machineName: 'OLD', isOwn: true, lastSeenAt: 1 }),
      candidate({ machineName: 'NEW', isOwn: true, lastSeenAt: 99 }),
    ];
    expect(sortExchangeBotCandidates(list).map((c) => c.machineName)).toEqual(['NEW', 'OLD']);
  });
});
