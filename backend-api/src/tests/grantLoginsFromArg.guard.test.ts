import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(HERE, '..', 'scripts');

/**
 * D-041 (24.08.2026): в отслеживаемых файлах не держат логины сотрудников —
 * репозиторий публичный, читает его кто угодно. Одноразовым скриптам состав круга
 * приходит СНАРУЖИ (аргументом запуска), а не литералом в коде.
 *
 * Сторож держит форму: скрипт выдачи прав берёт круг флагом `--editors=`, а массив
 * логинов в коде скриптов — всегда регресс (так было с правом на этапы работ).
 *
 * Логинов в самом стороже тоже нет — иначе он стал бы тем же нарушением.
 */
const GRANT_SCRIPTS = [
  'grantWorkSheetsEditTrio.ts',
  'grantProductionProgramEditTrio.ts',
  'grantProductionProgramSection.ts',
];

describe('скрипты выдачи прав — круг приходит аргументом (D-041)', () => {
  it('в каждом скрипте выдачи круг берётся флагом --editors', () => {
    for (const file of GRANT_SCRIPTS) {
      const src = readFileSync(join(SCRIPTS_DIR, file), 'utf8');
      expect(src, `${file}: круг должен приходить аргументом --editors`).toContain("'--editors'");
      expect(src, `${file}: разбор круга — общий помощник editorsFromArg`).toContain('editorsFromArg');
    }
  });

  it('в скриптах backend нет массива логинов', () => {
    const files = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.ts'));
    const loginArray = /const\s+\w*(LOGIN|USER|TRIO|ACCOUNT|EDITOR)\w*\s*=\s*\[\s*['"`]/i;
    for (const file of files) {
      const src = readFileSync(join(SCRIPTS_DIR, file), 'utf8');
      expect(src, `${file}: логины в коде не держим (D-041) — состав круга приходит аргументом`).not.toMatch(
        loginArray,
      );
    }
  });
});
