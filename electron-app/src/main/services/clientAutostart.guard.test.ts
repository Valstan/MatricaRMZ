import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// C9 (план client-stability-and-ai-2026-10): автозапуск клиента + снятие
// аварийной кнопки. Проводка размазана по трём слоям (main/index.ts, NSIS,
// самолечение), и каждый рвётся молча: нет ярлыка — нет автозапуска, а тесты
// сервисов при этом зелёные.
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
    expect(INDEX).toContain('if (!minimizedLaunch) showStartupStatus(');
    expect(INDEX).toContain('if (minimizedLaunch && !userRequestedShow) {');
    expect(INDEX).toContain('startup: window stays hidden (minimized launch');
  });

  it('свёрнутый запуск живёт треем с ручкой «Открыть/Выход»', () => {
    expect(INDEX).toContain('if (minimizedLaunch) ensureTray();');
    expect(INDEX).toContain("new Tray(image)");
    expect(INDEX).toContain('Открыть Матрицу');
    expect(INDEX).toContain('tray.destroy()');
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
