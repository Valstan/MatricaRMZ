// Гейт дублей сотрудников в единой двери записи карточки.
//
// Проверяем то, что нельзя увидеть без прогона: гейт считает ключ личности из ВСЕХ
// полей карточки разом (а не по одному атрибуту, как было), блокирует только связь,
// которую запись САМА создала (старый дубль править можно), и не пишет ничего, если
// гейт не пропустил.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type CheckMatch = {
  id: string;
  fullName: string;
  login: string | null;
  personnelNumber: string | null;
  relation: 'different' | 'disputed' | 'exact' | 'personnel';
  isNew: boolean;
  matchedBy: string[];
  conflicts: string[];
};

type CheckResult = { ok: true; relation: CheckMatch['relation']; matches: CheckMatch[] };

const hoisted = vi.hoisted(() => ({
  /** Текущие значения атрибутов карточки в локальной реплике. */
  attrs: new Map<string, Record<string, unknown>>(),
  /** Что фактически записано в реплику. */
  written: [] as Array<{ code: string; value: unknown }>,
  /** Ответ сервера на проверку ключа. */
  check: { ok: true as const, relation: 'different' as const, matches: [] } as CheckResult,
  checkCalls: [] as unknown[],
}));

vi.mock('./entityService.js', () => ({
  getEntityDetails: vi.fn(async (_db: unknown, id: string) => {
    const attributes = hoisted.attrs.get(id) ?? {};
    return { id, attributes };
  }),
  setEntityAttribute: vi.fn(async (_db: unknown, _id: string, code: string, value: unknown) => {
    hoisted.written.push({ code, value });
    return { ok: true as const };
  }),
}));

const { saveEmployeeCardGated, __testables } = await import('./employeeCardWrite.js');

const DB = {} as never;

function deps() {
  return {
    db: DB,
    typeId: 'type-employee',
    checkKey: vi.fn(async (args: unknown) => {
      hoisted.checkCalls.push(args);
      return hoisted.check;
    }),
  };
}

beforeEach(() => {
  hoisted.attrs.clear();
  hoisted.written.length = 0;
  hoisted.checkCalls.length = 0;
  hoisted.check = { ok: true as const, relation: 'different', matches: [] };
});

describe('ключ личности считается из всех полей сразу', () => {
  it('ключевые поля собираются из карточки целиком, а не по одному', async () => {
    hoisted.attrs.set('e-1', { full_name: 'Иванов Иван Иванович', personnel_number: '100' });

    await saveEmployeeCardGated(deps(), 'e-1', {
      full_name: 'Иванов Иван Иванович',
      personnel_number: '100',
      role: 'Слесарь',
      hire_date: 1715904000000,
      birth_date: 631152000000,
      last_name: 'Иванов',
    });

    // В проверку ушли все пять полей ключа, а не только написанные в этот раз.
    const sent = hoisted.checkCalls[0] as { after: Record<string, unknown> };
    expect(Object.keys(sent.after).sort()).toEqual(
      ['birth_date', 'full_name', 'hire_date', 'personnel_number', 'role'].sort(),
    );
  });

  it('серверу уходит «до» — состояние карточки до записи', async () => {
    hoisted.attrs.set('e-1', { full_name: 'Иванов Иван Иванович', personnel_number: '100' });

    await saveEmployeeCardGated(deps(), 'e-1', { personnel_number: '200' });

    const sent = hoisted.checkCalls[0] as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(sent.before['personnel_number']).toBe('100');
    expect(sent.after['personnel_number']).toBe('200');
  });
});

describe('уровни отказа гейта', () => {
  it('совпал полный ключ (ФИО + должность + дата приёма) — запрет с обоснованием', async () => {
    hoisted.check = {
      ok: true as const,
      relation: 'exact',
      matches: [
        {
          id: 'e-9',
          fullName: 'Иванов Иван Иванович',
          login: 'ivanov',
          personnelNumber: '100',
          relation: 'exact',
          isNew: true,
          matchedBy: ['full_name', 'role', 'hire_date'],
          conflicts: [],
        },
      ],
    };

    const r = await saveEmployeeCardGated(deps(), 'e-1', {
      full_name: 'Иванов Иван Иванович',
      role: 'Слесарь',
      hire_date: 1715904000000,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockReason).toBe('exact');
    expect(r.duplicates.map((d) => d.id)).toEqual(['e-9']);
    // Запись не выполнена — карточка не осталась наполовину заведённой.
    expect(hoisted.written).toEqual([]);
  });

  it('занят табельный номер — запрет без обхода', async () => {
    hoisted.check = {
      ok: true as const,
      relation: 'personnel',
      matches: [
        {
          id: 'e-9',
          fullName: 'Иванов Иван Иванович',
          login: 'ivanov',
          personnelNumber: '100',
          relation: 'personnel',
          isNew: true,
          matchedBy: ['personnel_number'],
          conflicts: [],
        },
      ],
    };

    const r = await saveEmployeeCardGated(deps(), 'e-1', { personnel_number: '100' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockReason).toBe('personnel');
    expect(hoisted.written).toEqual([]);
  });

  it('совпало только ФИО — предупреждение, а не запрет', async () => {
    hoisted.check = {
      ok: true as const,
      relation: 'disputed',
      matches: [
        {
          id: 'e-9',
          fullName: 'Иванов Иван Иванович',
          login: null,
          personnelNumber: null,
          relation: 'disputed',
          isNew: true,
          matchedBy: ['full_name'],
          conflicts: [],
        },
      ],
    };

    const r = await saveEmployeeCardGated(deps(), 'e-1', { full_name: 'Иванов Иван Иванович' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockReason).toBe('name');
  });

  it('старая связь (дубль был до записи) — не блокирует: дубль надо дать поправить', async () => {
    hoisted.check = {
      ok: true as const,
      relation: 'different',
      matches: [
        {
          id: 'e-9',
          fullName: 'Иванов Иван Иванович',
          login: null,
          personnelNumber: null,
          relation: 'exact',
          isNew: false,
          matchedBy: ['full_name', 'role', 'hire_date'],
          conflicts: [],
        },
      ],
    };

    const r = await saveEmployeeCardGated(deps(), 'e-1', { role: 'Слесарь' });

    expect(r.ok).toBe(true);
    expect(hoisted.written.length).toBeGreaterThan(0);
  });
});

describe('обход гейта и запись', () => {
  it('force — обходит проверку и пишет все поля', async () => {
    const d = deps();
    const r = await saveEmployeeCardGated(
      { ...d, checkKey: d.checkKey },
      'e-1',
      { full_name: 'Иванов Иван Иванович', role: 'Слесарь' },
      { force: true },
    );

    expect(r.ok).toBe(true);
    // При обходе проверка НЕ повторяется: тот же ключ дал бы тот же отказ.
    expect(hoisted.checkCalls).toEqual([]);
    expect(hoisted.written.map((w) => w.code)).toEqual(['full_name', 'role']);
  });

  it('сервер недоступен — запись не блокируется (клиент без сети должен работать)', async () => {
    const d = deps();
    const r = await saveEmployeeCardGated(
      { ...d, checkKey: async () => ({ ok: false as const, error: 'server unreachable' }) },
      'e-1',
      { full_name: 'Иванов Иван Иванович' },
    );

    expect(r.ok).toBe(true);
    expect(hoisted.written.length).toBe(1);
  });

  it('поля вне ключа не спрашивают сервер вовсе', async () => {
    const d = deps();
    const r = await saveEmployeeCardGated({ ...d, checkKey: d.checkKey }, 'e-1', {
      attachments: [{ id: 'f-1' }],
      transfers: [],
    });

    expect(r.ok).toBe(true);
    expect(hoisted.checkCalls).toEqual([]);
    expect(hoisted.written.map((w) => w.code)).toEqual(['attachments', 'transfers']);
  });

  it('ошибка записи поля возвращается как отказ, а не молчаливый успех', async () => {
    const d = deps();
    vi.mocked((await import('./entityService.js')).setEntityAttribute).mockResolvedValueOnce({
      ok: false as const,
      error: 'неизвестный атрибут',
    } as never);
    const r = await saveEmployeeCardGated({ ...d, checkKey: d.checkKey }, 'e-1', { full_name: 'X' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('full_name');
  });
});

describe('уровни отказа', () => {
  it('уровень связи переводится в уровень отказа гейта', () => {
    expect(__testables.blockReasonFor('personnel')).toBe('personnel');
    expect(__testables.blockReasonFor('exact')).toBe('exact');
    expect(__testables.blockReasonFor('disputed')).toBe('name');
    expect(__testables.blockReasonFor('different')).toBeNull();
  });
});
