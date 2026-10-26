import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож 3.87.0 (владелец 21.10.2026): черновики-«гвоздь», проверка часов,
 * кнопка «Перезапуск» (до 26.10.2026 — «Перезапустить программу»).
 *
 * Проверяем текстом исходников: живёт поведение вживую — на стенде (CDP-смоук),
 * а эти договорённости должны быть видны в коде, иначе их легко потерять.
 */

const here = resolve(__dirname);
const APP = readFileSync(resolve(here, '../../renderer/src/ui/App.tsx'), 'utf8');
const SHELL = readFileSync(resolve(here, '../../renderer/src/ui/shellV3/V3TabShell.tsx'), 'utf8');
const DRAFTS_IPC = readFileSync(resolve(here, '../ipc/register/drafts.ts'), 'utf8');
const SYSTEM_IPC = readFileSync(resolve(here, '../ipc/register/system.ts'), 'utf8');
const CLOCK = readFileSync(resolve(here, 'clockSkewService.ts'), 'utf8');
const MAIN = readFileSync(resolve(here, '../index.ts'), 'utf8');
const TABS = readFileSync(resolve(here, '../../../../shared/src/domain/tabsModel.ts'), 'utf8');
const CLOCK_DOMAIN = readFileSync(resolve(here, '../../../../shared/src/domain/clockSkew.ts'), 'utf8');

describe('черновики: вкладка, которую нельзя закрыть', () => {
  it('вкладка появляется сама, когда черновики есть, и стоит рядом с Ииванычем', () => {
    expect(APP).toContain('draftsCount');
    expect(APP).toContain("tabId: 'drafts', label: 'Черновики'");
    expect(APP).toContain("afterTabId: 'ai_chat'");
    expect(TABS).toContain('afterTabId');
  });

  it('счётчик обновляется по событию из main, а не по таймеру', () => {
    expect(DRAFTS_IPC).toContain("send('drafts:changed')");
    expect(APP).toContain('window.matrica.drafts.onChanged');
  });

  it('бейдж красный и со счётчиком', () => {
    expect(SHELL).toContain('v3-tab-drafts-badge');
    expect(SHELL).toContain('data-drafts-count');
  });

  it('крестик неактивен, пока черновики есть, и активен, когда их не осталось', () => {
    expect(SHELL).toContain('v3-tab-close-locked');
    expect(SHELL).toContain('Пока есть черновики, вкладку закрыть нельзя');
    expect(APP).toContain('canClose:');
    expect(APP).toContain("t.tabId === 'drafts' && draftsCount > 0");
  });

  it('модалка восстановления ведёт в список черновиков, а не открывает черновик наугад', () => {
    expect(APP).toContain('openDraftsTab');
    expect(APP).toContain('Разобрать черновики');
  });
});

describe('часы: расхождение с сервером', () => {
  it('порог — не меньше двух минут, проверка — раз в два часа', () => {
    expect(CLOCK_DOMAIN).toContain('CLOCK_SKEW_THRESHOLD_MS = 2 * 60 * 1000');
    expect(CLOCK_DOMAIN).toContain('CLOCK_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000');
  });

  it('источник истины — заголовок Date нашего сервера, поправка на половину RTT', () => {
    expect(CLOCK).toContain("headers.get('date')");
    expect(CLOCK_DOMAIN).toContain('computeClockSkew');
  });

  it('предупреждение — плашка в шапке, не модалка', () => {
    expect(SHELL).toContain('v3-clock-skew');
    expect(SHELL).toContain('data-clock-skew="problem"');
    expect(SHELL).not.toContain('role="dialog"');
  });

  it('в плашке есть «Синхронизировать» и «Открыть настройки времени»', () => {
    expect(SHELL).toContain('Синхронизировать');
    expect(SHELL).toContain('Открыть настройки времени');
    expect(SYSTEM_IPC).toContain('system:clockSync');
    expect(SYSTEM_IPC).toContain('system:openDateTimeSettings');
  });
});

describe('перезапуск программы', () => {
  it('кнопка в шапке зовёт штатный рестарт', () => {
    expect(SHELL).toContain('data-restart-app-btn');
    // Подпись короткая (владелец 26.10.2026): «Перезапуск» — рядом с аккаунтом длинная
    // фраза не помещалась. Что именно происходит, сказано в подсказке кнопки.
    expect(SHELL).toContain('<span className="v3-account-name">Перезапуск</span>');
    expect(SHELL).toContain('компьютер перезагружать не нужно');
    expect(SHELL).not.toContain('Перезапустить программу');
    expect(APP).toContain('window.matrica.system.restart');
  });

  it('рестарт идёт через relaunch после гашения, а не убийством процесса', () => {
    expect(SYSTEM_IPC).toContain('app.relaunch()');
    expect(SYSTEM_IPC).toContain('app.quit()');
    // Страховка: если гашение зависло — выходим принудительно, рестарт всё равно состоится.
    expect(SYSTEM_IPC).toContain('app.exit(0)');
  });

  it('в режиме просмотра бэкапа перезапуск недоступен', () => {
    expect(SYSTEM_IPC).toContain('isViewMode(ctx)');
    expect(SYSTEM_IPC).toContain('перезапуск недоступен');
  });

  it('часы начинают проверяться при старте клиента', () => {
    expect(MAIN).toContain('startClockChecks');
  });
});
