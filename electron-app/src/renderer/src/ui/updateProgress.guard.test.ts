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
const FLOW_DOMAIN = src('../../../../../shared/src/domain/updateFlow.ts');

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

  it('фон открывает окно апдейтера только когда все источники исчерпаны', () => {
    // Вторая поверхность прогресса — «полос несколько». В обычной скачке окна быть не
    // должно: оператора зовёт тихая плашка в главном окне.
    //
    // Проверка раньше была пустой: срез «от тика до export function startBackgroundUpdatePolling»
    // давал ПУСТУЮ строку (экспорт объявлен выше вложенного тика), а `not.toContain` по пустой
    // строке проходит всегда. Теперь срез по границам тика, а свойство — настоящее: окно
    // открывается ровно в одном месте — ручной откат, когда ни один источник не сработал.
    const background = SERVICE.slice(SERVICE.indexOf('async function tick('), SERVICE.indexOf('export async function runAutoUpdateFlow('));
    const calls = background.match(/showUpdateWindow\(/g) ?? [];
    expect(calls.length, 'окно в фоне открывается только для ручного скачивания').toBe(1);
    const windowAt = background.indexOf('showUpdateWindow(');
    const offerAt = background.indexOf('await offerInstall({');
    const fallbackAt = background.indexOf('promptManualUpdateFallback({');
    expect(offerAt, 'при обычном скачивании окно апдейтера не открывается').toBeGreaterThan(-1);
    expect(windowAt, 'ручной откат открывает окно').toBeGreaterThan(offerAt);
    expect(fallbackAt).toBeGreaterThan(windowAt);
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

  it('состояние сохраняет версию обновления', () => {
    // Ловушка: при переходе на applyProgress поле `version` потерялось, и тихое сообщение
    // «вышло обновление» молча не показывалось (версия приходила пустой).
    expect(SERVICE).toContain('...(toVersion ? { version: toVersion } : {}),');
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

describe('полоса не застревает', () => {
  it('dev-сборка не оставляет стадию «checking» над рабочим экраном', () => {
    // Симптом (20.11.2026, стенд): полоса «Матрица3-РМЗ (135) · 0% · оценка недоступна» висела
    // поверх всех окон до конца сессии. Причина: dev-выход из флоу обновления стоял ПОСЛЕ стадии
    // «Проверяем обновления…» — состояние «checking» уходило в главное окно, и его уже никто
    // не снимал (в установленном клиенте ветка «uptodate» полосу гасит, а в dev — нет).
    const flow = SERVICE.slice(SERVICE.indexOf('export async function runAutoUpdateFlow('));
    const devExit = flow.indexOf('if (!app.isPackaged)');
    const checking = flow.indexOf("await stageUpdate('Проверяем обновления…', 0);");
    expect(devExit, 'dev-выход из флоу обновления должен быть').toBeGreaterThan(-1);
    expect(checking, 'стадия «Проверяем обновления…» должна остаться в коде').toBeGreaterThan(-1);
    expect(devExit, 'dev-выход должен быть ДО стадии checking — иначе полоса застревает на весь сеанс').toBeLessThan(
      checking,
    );
    expect(flow, 'dev-выход обязан вернуть состояние в «покоя»').toContain("setUpdateState({ state: 'idle' });");
  });
});

describe('оператор видит и решает', () => {
  it('модалки «сейчас или позже» больше нет — обновление приходит тихо', () => {
    expect(APP, 'модалка выскакивала посреди работы и пугала: будто программа сама перезагрузится').not.toContain('data-update-now');
    expect(APP).not.toContain('data-update-later');
    // Текст подсказки живёт в домене (одна формулировка на всех), а окно его показывает.
    expect(FLOW_DOMAIN, 'вместо модалки — одно тихое сообщение').toContain('Вышло обновление');
    expect(APP).toContain('formatUpdateReadyNotice({');
    expect(APP).toContain('«Перезапуск»');
  });

  it('сообщение повторяется, пока обновление не поставили — одной плашки мало', () => {
    // Владелец 21.11.2026: «у меня стоит 136 версия и не обновляется на следущие».
    // Обновление лежало готовое сутки, а плашка про него показалась ОДИН раз и погасла —
    // оператор о готовом обновлении просто не знал. Раньше здесь было свойство
    // «сообщение одно на версию»; теперь сообщение повторяется, пока обновление ждёт.
    expect(APP).toContain('const UPDATE_REMINDER_EVERY_MS = 30 * 60_000;');
    expect(APP).toContain("window.setInterval(() => notifyOperator(text, 'reminder'), UPDATE_REMINDER_EVERY_MS)");
    expect(APP, 'подсказка берётся из домена — одна формулировка на всех').toContain('formatUpdateReadyNotice({');
  });

  it('кнопка «Перезапуск» сама говорит, что обновление готово', () => {
    // Плашка гаснет — нужна постоянная примета в шапке: точка и другая рамка.
    expect(SHELL).toContain('data-update-ready');
    expect(SHELL).toContain('v3-restart-btn--ready');
    expect(SHELL_CSS).toContain('.v3-restart-btn--ready');
    expect(APP).toContain("updateReady={updateState?.state === 'downloaded'}");
  });

  it('кнопка «Перезапуск» применяет скачанное обновление, а не просто перезапускает', () => {
    expect(APP, 'иначе «нажмите ‹Перезапуск›» не даст новой версии').toContain("updateState?.state === 'downloaded'");
    expect(APP).toContain('window.matrica.update.installNow()');
  });

  it('«Позже» ничего не теряет — обновление уже записано отложенным', () => {
    expect(SERVICE).toContain('await queuePendingUpdate({');
    expect(SERVICE).toContain('export async function applyPendingUpdateIfAny(');
  });
});

// Отложенное обновление НЕ ИМЕЕТ ПРАВА ГЛУШИТЬ более новое (владелец 21.11.2026:
// «у меня стоит 136 версия и не обновляется на следущие»).
//
// Живой случай: 3.137.0 скачано и лежит отложенным, программа на 3.136.0, сервер уже
// отдаёт 3.138.0. Старый код видел отложенное и сразу выходил — сервер про 3.138.0 не
// спрашивал вовсе, и машина ждала нажатия «Перезапуск» сутками. Парк стоял на старых
// версиях по той же причине.
describe('отложенное обновление не глушит более новое', () => {
  const tick = SERVICE.slice(SERVICE.indexOf('async function tick('), SERVICE.indexOf('export async function runAutoUpdateFlow('));

  it('фон спрашивает сервер ДО того, как решает судьбу отложенного', () => {
    expect(tick).toContain('chooseUpdateFlow({');
    expect(tick).toContain('fetchLatestUpdateMetaFromServer()');
    const flowAt = tick.indexOf('chooseUpdateFlow({');
    const offerAt = tick.indexOf("if (flow === 'offer-pending'");
    expect(flowAt).toBeGreaterThan(-1);
    expect(offerAt, 'сначала решение, потом отложенное — иначе сервер не спрашивают').toBeGreaterThan(flowAt);
  });

  it('устаревшее отложенное выбрасывается, а не предлагается как «готовое»', () => {
    expect(tick).toContain("if (flow === 'discard-pending')");
    expect(tick).toContain('await clearPendingUpdate();');
  });

  it('правило живёт в домене и покрыто тестами', () => {
    expect(FLOW_DOMAIN).toContain('export function chooseUpdateFlow');
    expect(FLOW_DOMAIN).toContain("'discard-pending'");
  });
});
