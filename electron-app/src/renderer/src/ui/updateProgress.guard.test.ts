import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Прогресс обновления и выбор «сейчас / позже» (владелец 08.09.2026). Рвётся молча в четырёх
// местах: сервис перестаёт слать состояние в главное окно (полосы нет, и о перезагрузке никто
// не предупреждён); фоновая проверка снова зовёт installNow напрямую (программа перезапускается
// посреди работы); модал спрашивает на каждое событие вместо одного раза на версию; кнопка
// «Установить сейчас» теряет мост и становится мёртвой.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const SERVICE = src('../../../main/services/updateService.ts');
const IPC = src('../../../main/ipc/register/update.ts');
const PRELOAD = src('../../../preload/index.ts');
const APP = src('./App.tsx');
const SHELL = src('./shellV3/V3TabShell.tsx');
const SHELL_CSS = src('./shellV3/shellV3.css');

describe('состояние обновления доезжает до главного окна', () => {
  it('сервис шлёт состояние при каждом его изменении', () => {
    expect(SERVICE).toContain('function pushUpdateStateToApp()');
    expect(SERVICE).toContain("w.webContents.send('update:appState', payload);");
    const setter = SERVICE.slice(SERVICE.indexOf('function setUpdateState('), SERVICE.indexOf('export function getUpdateState'));
    expect(setter, 'без вызова из сеттера окно узнает о прогрессе только случайно').toContain('pushUpdateStateToApp();');
  });

  it('окно апдейтера своё состояние получает по-прежнему отдельно', () => {
    expect(SERVICE).toContain("w.webContents.send('update:state', updateUiViewState);");
    expect(SERVICE, 'иначе окно апдейтера получило бы оба потока и мигало').toContain(
      'if (updateUiWindow && !updateUiWindow.isDestroyed() && w.id === updateUiWindow.id) continue;',
    );
  });

  it('мост отдаёт подписку и кнопку установки', () => {
    expect(PRELOAD).toContain("ipcRenderer.on('update:appState', wrapped);");
    expect(PRELOAD).toContain("installNow: async () => ipcRenderer.invoke('update:installNow'),");
    expect(IPC).toContain("ipcMain.handle('update:installNow'");
    expect(IPC, 'установка — действие с правами, а не свободный вызов').toContain("requirePermOrResult(ctx, 'updates.use')");
  });
});

describe('фон предлагает, а не ставит молча', () => {
  it('фоновая проверка ведёт к предложению установки', () => {
    expect(SERVICE).toContain('async function offerInstall(args: { installerPath: string; version?: string })');
    expect(SERVICE).toContain('await offerInstall({');
    expect(SERVICE, 'предложение обязано помнить, ЧТО ставить').toContain('pendingInstallOffer = {');
  });

  it('явная проверка по кнопке по-прежнему ставит сразу', () => {
    // Оператор сам попросил обновиться — спрашивать второй раз незачем.
    const flow = SERVICE.slice(SERVICE.indexOf('export async function runAutoUpdateFlow('));
    expect(flow).toContain('await installNow({');
    expect(flow).not.toContain('await offerInstall({');
  });

  it('установка по кнопке идёт тем же путём, что и раньше', () => {
    expect(SERVICE).toContain('export async function installOfferedUpdate()');
    expect(SERVICE).toContain('await installNow(offer);');
  });
});

describe('оператор видит и решает', () => {
  it('полоса прогресса живёт под вкладками и не мешает их читать', () => {
    expect(SHELL).toContain('data-update-progress');
    expect(SHELL_CSS).toContain('.v3-tabs-progress');
    expect(SHELL_CSS, 'заливка обязана быть ПОД вкладками').toContain('z-index: 0;');
    expect(APP).toContain("updateState?.state === 'downloading'");
  });

  it('вопрос задаётся один раз на версию, а не на каждое событие', () => {
    expect(APP).toContain('if (!version || updateInstallAsked === version) return null;');
    expect(APP).toContain('data-update-later');
    expect(APP).toContain('data-update-now');
  });

  it('«Позже» ничего не теряет — обновление уже записано отложенным', () => {
    expect(SERVICE).toContain('await queuePendingUpdate(');
    expect(SERVICE).toContain('export async function applyPendingUpdateIfAny(');
  });
});
