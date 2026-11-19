import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Прогресс обновления (владелец 08.11.2026): «сейчас полос несколько — заменить на одну тонкую
// длинную посреди экрана», «прогресс идёт только вперёд и не прыгает назад», «сколько секунд
// осталось». Рвётся молча в четырёх местах: главное окно и окно апдейтера считают процент
// по-разному (скачивание до 100%, установка с 80% — полоса прыгает назад); ETA живёт только в
// окне апдейтера, поэтому в главном окне «осталось N с» не видно; в главном окне остаётся
// вторая полоса (заливка под вкладками); в состоянии нет версий «с какой на какую».
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const SERVICE = src('../../../main/services/updateService.ts');
const IPC = src('../../../main/ipc/register/update.ts');
const PRELOAD = src('../../../preload/index.ts');
const APP = src('./App.tsx');
const SHELL = src('./shellV3/V3TabShell.tsx');
const SHELL_CSS = src('./shellV3/shellV3.css');
const DOMAIN = src('../../../../../shared/src/domain/updateProgress.ts');

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

  it('фоновая загрузка не открывает окно апдейтера', () => {
    // Вторая поверхность прогресса — «полос несколько». В фоне окна быть не должно.
    const background = SERVICE.slice(SERVICE.indexOf('async function tick('), SERVICE.indexOf('export function startBackgroundUpdatePolling'));
    expect(background, 'фон не должен открывать вторую поверхность прогресса').not.toContain('showUpdateWindow(');
  });
});

describe('одна полоса и общий процент', () => {
  it('процент считается по весам этапов и только вперёд', () => {
    expect(DOMAIN).toContain('export const UPDATE_STAGE_RANGES');
    expect(SERVICE).toContain('monotonicOverallPct(');
    expect(SERVICE).toContain('stageOverallPct(');
    expect(
      SERVICE,
      'у каждого этапа своя часть полосы — иначе скачивание до 100% и прыжок назад при установке',
    ).toContain('lastOverallPct = monotonicOverallPct(lastOverallPct, stageOverallPct(stage, stagePct));');
  });

  it('главное окно и окно апдейтера получают одно и то же число', () => {
    expect(SERVICE).toContain('applyProgress({ stage, stagePct, version: next.version || null, message: msg });');
    expect(SERVICE, 'общий процент — в состоянии главного окна').toContain('overallPct,');
  });

  it('в главном окне одна полоса — тонкая, посреди экрана', () => {
    expect(SHELL).toContain('data-update-progress');
    expect(SHELL).toContain('v3-update-bar');
    expect(SHELL_CSS).toContain('.v3-update-bar');
    expect(SHELL_CSS, 'полоса — посреди экрана').toContain('top: 50%;');
    expect(SHELL, 'старой заливки под вкладками больше нет').not.toContain('v3-tabs-progress');
    expect(SHELL_CSS, 'старой заливки под вкладками больше нет').not.toContain('.v3-tabs-progress');
  });

  it('на полосе видно версии, процент и секунды', () => {
    expect(SHELL).toContain('formatEtaSeconds(props.updateProgress.etaSeconds)');
    expect(APP).toContain('fromLabel: updateState?.fromVersion ? formatAppVersionLabel(updateState.fromVersion) : null');
    expect(APP).toContain('toLabel: updateState?.toVersion ? formatAppVersionLabel(updateState.toVersion) : null');
    expect(SERVICE, 'в состоянии есть версии «с какой на какую»').toContain('fromVersion: app.getVersion()');
  });

  it('без оценки времени показывается прочерк, а не ноль', () => {
    expect(DOMAIN).toContain("return 'оценка недоступна';");
    expect(SERVICE, 'ETA приходит в главное окно, а не только в окно апдейтера').toContain('etaSeconds: etaForStage(args.stage)');
  });

  it('оценка установки берётся из прошлой установки, а не выдумывается', () => {
    expect(SERVICE).toContain('lastInstallDurationMs');
    expect(SERVICE).toContain('noteInstallStarted');
    expect(SERVICE).toContain('noteInstallTimingOnBoot');
  });
});

describe('оператор видит и решает', () => {
  it('вопрос задаётся один раз на версию, а не на каждое событие', () => {
    expect(APP).toContain('if (!version || updateInstallAsked === version) return null;');
    expect(APP).toContain('data-update-later');
    expect(APP).toContain('data-update-now');
  });

  it('«Позже» ничего не теряет — обновление уже записано отложенным', () => {
    expect(SERVICE).toContain('await queuePendingUpdate({');
    expect(SERVICE).toContain('export async function applyPendingUpdateIfAny(');
  });
});
