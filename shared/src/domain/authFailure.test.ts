import { describe, expect, it } from 'vitest';

import { authFailureNeedsModal, describeAuthFailure, describeAuthNetworkFailure } from './authFailure.js';

// Оператор не должен видеть `login HTTP 401: {"ok":false,...}` — только фразу о том, что случилось.
describe('describeAuthFailure', () => {
  it('401 — неверный пароль, модалкой и без кода в тексте', () => {
    const f = describeAuthFailure({ status: 401, rawBody: '{"ok":false,"error":"неверные учетные данные"}' });
    expect(f.code).toBe('invalid_credentials');
    expect(f.message).toContain('Неверный логин или пароль');
    expect(f.message).not.toMatch(/401|HTTP|\{/);
    expect(authFailureNeedsModal(f.code)).toBe(true);
  });

  it('403 сотрудника без доступа берёт текст сервера, 403 о резерве — свой код', () => {
    const noAccess = describeAuthFailure({ status: 403, rawBody: '{"ok":false,"error":"у сотрудника нет доступа"}' });
    expect(noAccess.code).toBe('no_access');
    expect(noAccess.message).toBe('У сотрудника нет доступа');

    const reserved = describeAuthFailure({ status: 403, rawBody: '{"ok":false,"error":"логин супер-админа зарезервирован"}' });
    expect(reserved.code).toBe('reserved_login');
    expect(authFailureNeedsModal(reserved.code)).toBe(false);
  });

  it('409 — занятый логин, 400 — незаполненные поля', () => {
    expect(describeAuthFailure({ status: 409, rawBody: '{"error":"логин уже существует"}' }).code).toBe('login_taken');
    const bad = describeAuthFailure({ status: 400, rawBody: '{"error":{"fieldErrors":{"login":["required"]}}}' });
    expect(bad.code).toBe('bad_request');
    // Объект Zod-а в сообщение не просачивается.
    expect(bad.message).not.toContain('fieldErrors');
  });

  it('5xx и пустое/битое тело не роняют разбор', () => {
    expect(describeAuthFailure({ status: 502 }).code).toBe('server');
    const unknown = describeAuthFailure({ status: 418, rawBody: '<html>gateway</html>' });
    expect(unknown.code).toBe('unknown');
    expect(unknown.message).not.toContain('html');
  });

  it('обрыв сети — отдельный код с модалкой', () => {
    const f = describeAuthNetworkFailure(new Error('net::ERR_CONNECTION_REFUSED'));
    expect(f.code).toBe('offline');
    expect(f.message).toContain('Нет связи с сервером');
    expect(authFailureNeedsModal(f.code)).toBe(true);
  });
});
