import { execFile } from 'node:child_process';
import { shell } from 'electron';

import {
  CLOCK_CHECK_INTERVAL_MS,
  CLOCK_SKEW_THRESHOLD_MS,
  EMPTY_CLOCK_SKEW,
  clockSkewIsProblem,
  computeClockSkew,
  type ClockSkew,
} from '@matricarmz/shared';

/**
 * Проверка расхождения часов компьютера с часами сервера.
 *
 * Источник истины — заголовок `Date` от нашего же сервера: сторонние сервисы
 * не нужны, трафик не тратим. Проверяем при старте и далее раз в 2 часа.
 * Порог предупреждения — 2 минуты.
 *
 * Само расхождение синк по `seq` не рвёт, но подписи документов и «свежесть»
 * записей от него страдают — поэтому предупреждаем оператора, а не чиним за него.
 */

let state: ClockSkew = { ...EMPTY_CLOCK_SKEW };
let timer: NodeJS.Timeout | null = null;

export function getClockSkewState(): ClockSkew {
  return { ...state };
}

export function clockSkewProblem(): boolean {
  return clockSkewIsProblem(state.skewMs, CLOCK_SKEW_THRESHOLD_MS);
}

/** Одна проверка: спрашиваем наш сервер и сравниваем заголовок `Date` с местными часами. */
export async function checkClockSkew(apiBaseUrl: string): Promise<ClockSkew> {
  const base = String(apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) {
    state = { ...EMPTY_CLOCK_SKEW, error: 'не задан адрес сервера' };
    return getClockSkewState();
  }
  const sentAt = Date.now();
  try {
    const res = await fetch(`${base}/health`, { method: 'GET', headers: { 'User-Agent': 'MatricaRMZ' } });
    const receivedAt = Date.now();
    const dateHeader = res.headers.get('date');
    const serverTimeMs = dateHeader ? Date.parse(dateHeader) : NaN;
    if (!Number.isFinite(serverTimeMs)) {
      state = { ...EMPTY_CLOCK_SKEW, checkedAt: receivedAt, error: 'сервер не вернул заголовок Date' };
      return getClockSkewState();
    }
    const { skewMs, rttMs } = computeClockSkew(sentAt, serverTimeMs, receivedAt);
    state = { skewMs, checkedAt: receivedAt, serverTimeMs, rttMs, error: null };
  } catch (e) {
    state = { ...EMPTY_CLOCK_SKEW, checkedAt: Date.now(), error: String((e as Error)?.message ?? e) };
  }
  return getClockSkewState();
}

/** Планировщик проверки: раз в 2 часа (и один раз сразу). */
export function startClockChecks(getApiBaseUrl: () => string): void {
  if (timer) return;
  const tick = () => {
    void checkClockSkew(getApiBaseUrl()).catch(() => undefined);
  };
  timer = setInterval(tick, CLOCK_CHECK_INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, 5_000).unref?.();
}

export function stopClockChecks(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Пробуем синхронизировать часы со службой времени Windows.
 * Без прав администратора `w32tm /resync` обычно откажет — говорим об этом честно.
 */
export async function syncSystemClock(): Promise<{ ok: boolean; error?: string; output?: string }> {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'синхронизация часов доступна только на Windows' };
  }
  return await new Promise((resolve) => {
    execFile('w32tm.exe', ['/resync'], { windowsHide: true, timeout: 20_000 }, (err, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
      if (err) {
        const denied = /access|denied|прав|privilege|0x80070520/i.test(output);
        resolve({
          ok: false,
          error: denied
            ? 'нужны права администратора — откройте «Настройки времени» и нажмите «Синхронизировать сейчас»'
            : `не удалось синхронизировать: ${output.slice(0, 200) || String(err.message ?? err)}`,
        });
        return;
      }
      resolve({ ok: true, output: output.slice(0, 200) });
    });
  });
}

/** Открыть настройки даты и времени Windows — работает без прав администратора. */
export function openDateTimeSettings(): { ok: boolean; error?: string } {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'настройки времени доступны только на Windows' };
  }
  try {
    void shell.openExternal('ms-settings:dateandtime');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
