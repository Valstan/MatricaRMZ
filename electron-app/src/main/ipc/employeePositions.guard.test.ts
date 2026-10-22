/**
 * Должность заводится из карточки сотрудника своей дверью, а не общим справочником.
 *
 * Регресс, который сторож ловит: карточка вернётся на `admin.entities.create` —
 * этот канал требует `masterdata.edit`, и кадровик с правом вносить сотрудников
 * снова получит отказ на кнопке «+Создать должность» (прод-случай 22.10.2026).
 * Обратная ошибка — «широкая» дверь: если она начнёт спрашивать `masterdata.edit`,
 * справочник должностей перестанет быть доступен кадровику, а его галочка
 * откроет заодно товары, бренды и услуги.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const registration = readFileSync(join(here, 'register', 'employees.ts'), 'utf8');
const card = readFileSync(join(here, '..', '..', 'renderer', 'src', 'ui', 'pages', 'EmployeeDetailsPage.tsx'), 'utf8');

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function handlerBody(channel: string): string {
  const start = registration.indexOf(`'${channel}'`);
  expect(start, `канал ${channel} не зарегистрирован`).toBeGreaterThan(-1);
  const next = registration.indexOf('ipcMain.handle(', start);
  return stripComments(registration.slice(start, next === -1 ? registration.length : next));
}

function funcBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`);
  expect(start, `функция ${name} не найдена`).toBeGreaterThan(-1);
  const next = text.indexOf('\n  async function ', start + 1);
  const nextSync = text.indexOf('\n  function ', start + 1);
  const end = [next, nextSync].filter((n) => n > 0).sort((a, b) => a - b)[0] ?? text.length;
  return stripComments(text.slice(start, end));
}

describe('должности из карточки сотрудника: узкая дверь по кадровому праву', () => {
  it('чтение справочника закрыто employees.view, а не masterdata.view', () => {
    const body = handlerBody('employees:positions:list');
    expect(body).toContain("'employees.view'");
    expect(body).not.toContain('masterdata.view');
  });

  it('создание закрыто employees.create, а не masterdata.edit', () => {
    const body = handlerBody('employees:positions:create');
    expect(body).toContain("'employees.create'");
    expect(body).not.toContain('masterdata.edit');
  });

  it('создание не подменяет существующую должность: дубль возвращается как reused', () => {
    const body = handlerBody('employees:positions:create');
    expect(body).toContain('normalizePositionKey');
    expect(body).toContain('reused: true');
    expect(body).toContain('reused: false');
  });

  it('карточка читает должности своей дверью', () => {
    expect(funcBody(card, 'loadEntityTypes')).toContain('window.matrica.employees.positionsList');
  });

  it('карточка заводит должность своей дверью, а не общим справочником', () => {
    const body = funcBody(card, 'createPosition');
    expect(body).toContain('window.matrica.employees.positionsCreate');
    expect(body).not.toContain('admin.entities.create');
    expect(body).not.toContain("code === 'position_ref'");
  });
});
