import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => 'C:/tmp/matricarmz-test',
    getVersion: () => '3.19.0',
  },
}));

import {
  DEFAULT_LAN_SHARE_PORT,
  isLanUpdateEnabled,
  resolveLanShareBinding,
  setLanShareEnabled,
} from './lanUpdateService.js';

/**
 * Раздача установщика между машинами цеха не работала всё время своего существования: реестр пиров
 * пуст, потому что выключателей было четыре и ни один не срабатывал. Здесь стережётся то, что
 * ломалось молча.
 */
describe('выключатель раздачи между машинами', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.MATRICA_UPDATE_LAN_ENABLED;
    delete process.env.MATRICA_UPDATE_LAN_BIND;
    delete process.env.MATRICA_UPDATE_LAN_PORT;
    setLanShareEnabled(false);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('решает доставленная с сервера настройка, а не переменная окружения', () => {
    expect(isLanUpdateEnabled()).toBe(false);
    setLanShareEnabled(true);
    expect(isLanUpdateEnabled()).toBe(true);
    setLanShareEnabled(false);
    expect(isLanUpdateEnabled()).toBe(false);
  });

  it('переменная окружения остаётся обходом для разработки и сильнее настройки', () => {
    setLanShareEnabled(false);
    process.env.MATRICA_UPDATE_LAN_ENABLED = 'true';
    expect(isLanUpdateEnabled()).toBe(true);

    setLanShareEnabled(true);
    process.env.MATRICA_UPDATE_LAN_ENABLED = 'false';
    expect(isLanUpdateEnabled()).toBe(false);
  });

  it('по умолчанию слушаем сеть, а не loopback — иначе соседи не достучатся', () => {
    expect(resolveLanShareBinding().host).toBe('0.0.0.0');
  });

  it('loopback можно потребовать явно', () => {
    process.env.MATRICA_UPDATE_LAN_BIND = '127.0.0.1';
    expect(resolveLanShareBinding().host).toBe('127.0.0.1');
  });

  it('порт фиксирован — правило брандмауэра нельзя выписать на случайный', () => {
    expect(resolveLanShareBinding().port).toBe(DEFAULT_LAN_SHARE_PORT);
    expect(DEFAULT_LAN_SHARE_PORT).toBeGreaterThan(0);
  });

  it('порт переопределяется явно, мусор в переменной откатывает к умолчанию', () => {
    process.env.MATRICA_UPDATE_LAN_PORT = '41000';
    expect(resolveLanShareBinding().port).toBe(41000);

    process.env.MATRICA_UPDATE_LAN_PORT = 'не число';
    expect(resolveLanShareBinding().port).toBe(DEFAULT_LAN_SHARE_PORT);

    process.env.MATRICA_UPDATE_LAN_PORT = '99999';
    expect(resolveLanShareBinding().port).toBe(DEFAULT_LAN_SHARE_PORT);
  });
});
