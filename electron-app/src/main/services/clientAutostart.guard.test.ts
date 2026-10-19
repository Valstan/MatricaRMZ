import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// C9 (план client-stability-and-ai-2026-10): автозапуск клиента + снятие
// аварийной кнопки. P3 (batch-pain-print-and-filters-2026-10): трей у всех,
// крестик прячет окно, старт не ждёт сеть. Проводка размазана по трём слоям
// (main/index.ts, NSIS, самолечение), и каждый рвётся молча: нет ярлыка — нет
// автозапуска, нет `ensureTray` — закрытие окна гасит программу.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const INDEX = src('../index.ts');
const NSH = src('../../../installer/installer.nsh');

describe('автозапуск клиента', () => {
  it('упакованный старт чинит запись (только primary, best-effort)', () => {
    expect(INDEX).toContain('ensureClientAutostart({');
    expect(INDEX).toContain("resolveStartupDir(app.getPath('appData'))");
  });

  it('свёрнутый запуск молчит: ни сплэша, ни окна без просьбы', () => {
    expect(INDEX).toContain('setStartupStatusSilent(minimizedLaunch)');
    expect(INDEX).toContain('if (!minimizedLaunch) showStartupStatus(');
    expect(INDEX).toContain('if (minimizedLaunch && !userRequestedShow) {');
    expect(INDEX).toContain('startup: window stays hidden (minimized launch');
  });

  it('трей живёт у всех клиентов, «Выход» — только его меню', () => {
    expect(INDEX).toMatch(/^\s*ensureTray\(\);$/m);
    expect(INDEX).not.toContain('if (minimizedLaunch) ensureTray();');
    expect(INDEX).toContain('new Tray(image)');
    expect(INDEX).toContain('Открыть Матрицу');
    expect(INDEX).toContain("requestAppQuit('tray menu')");
    expect(INDEX).toContain('tray.destroy()');
  });

  it('крестик прячет окно в трей, а не гасит программу', () => {
    expect(INDEX).toContain('window closed to tray');
    expect(INDEX).toContain('mainWindow?.hide();');
  });

  it('настоящий выход не может зависнуть на окне', () => {
    expect(INDEX).toContain('quit fallback: renderer did not confirm');
    expect(INDEX).toContain("ipcMain.on('app:close-response'");
  });

  it('трей держит приложение: window-all-closed его не гасит', () => {
    expect(INDEX).toContain('if (tray) return;');
  });

  it('повторный запуск и dock показывают окно, а не второй процесс', () => {
    expect(INDEX).toContain('userRequestedShow = true;');
    expect(INDEX).toContain('requestMainWindowShow');
  });

  it('установщик кладёт ярлык с --minimized и чистит кнопку при обновлении', () => {
    expect(NSH).toContain('!macro InstallClientAutostart');
    expect(NSH).toContain('"$SMSTARTUP\\MatricaRMZ.lnk"');
    expect(NSH).toContain('"--minimized"');
    expect(NSH).toContain('!insertmacro InstallClientAutostart');
    expect(NSH).toContain('Delete "$DESKTOP\\Восстановить Матрицу РМЗ.lnk"');
    expect(NSH).toContain('Delete "$SMSTARTUP\\MatricaRMZ.lnk"');
  });

  it('аварийная кнопка не создаётся ни установщиком, ни клиентом', () => {
    expect(NSH).not.toContain('CreateShortCut "$DESKTOP\\Восстановить Матрицу РМЗ.lnk"');
    expect(INDEX).not.toContain('Восстановить Матрицу РМЗ.lnk');
  });
});

// P3, шаги 1 и 3: старт не держится сетью, и по логу видно, какой этап сколько съел.
describe('старт клиента не ждёт сеть (P3)', () => {
  it('сверка схемы при старте идёт с коротким бюджетом', () => {
    expect(INDEX).toMatch(/attempts: 1,\s*timeoutMs: 4_000,/);
  });

  it('окно создаётся до сетевой проверки обновлений', () => {
    const windowAt = INDEX.indexOf("await markStage('Загружаю окно');");
    const updateAt = INDEX.indexOf("void runAutoUpdateFlow({ reason: 'startup'");
    expect(windowAt).toBeGreaterThan(0);
    expect(updateAt).toBeGreaterThan(windowAt);
  });

  it('применение уже скачанного обновления остаётся до окна', () => {
    const applyAt = INDEX.indexOf('await applyPendingUpdateIfAny(null);');
    const windowAt = INDEX.indexOf("await markStage('Загружаю окно');");
    expect(applyAt).toBeGreaterThan(0);
    expect(windowAt).toBeGreaterThan(applyAt);
  });

  it('каждый этап старта пишется в лог с временем', () => {
    expect(INDEX).toContain('startup-stage: ${spent}ms -> ${stage}');
    expect(INDEX).toContain('startup: window created after');
  });

  it('тихий режим окна этапов снимается, когда окно попросили явно', () => {
    const statusSrc = src('./startupStatusWindow.ts');
    expect(statusSrc).toContain('export function setStartupStatusSilent');
    expect(statusSrc).toContain('if (silent) return;');
    expect(statusSrc).toContain('silent = false;');
  });
});
