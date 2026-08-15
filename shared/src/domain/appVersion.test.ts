import { describe, expect, it } from 'vitest';

import {
  APP_GENERATION,
  VERSION_EPOCH_CALVER,
  VERSION_EPOCH_GENERATION,
  VERSION_EPOCH_LEGACY,
  appProductName,
  compareAppVersion,
  formatAppVersionLabel,
  nextGenerationVersion,
  parseGenerationVersion,
  versionEpoch,
} from './appVersion.js';

describe('versionEpoch', () => {
  it('относит CalVer к своей эпохе', () => {
    expect(versionEpoch('2026.814.1503')).toBe(VERSION_EPOCH_CALVER);
    expect(versionEpoch('2026.622.1241')).toBe(VERSION_EPOCH_CALVER);
  });

  it('относит нумерацию поколения к своей эпохе', () => {
    expect(versionEpoch(`${APP_GENERATION}.1.0`)).toBe(VERSION_EPOCH_GENERATION);
    expect(versionEpoch('3.27.0')).toBe(VERSION_EPOCH_GENERATION);
    expect(versionEpoch('4.1.0')).toBe(VERSION_EPOCH_GENERATION);
  });

  it('относит доисторические 1.x/2.x к легаси', () => {
    expect(versionEpoch('1.0.5')).toBe(VERSION_EPOCH_LEGACY);
    expect(versionEpoch('2.3.1')).toBe(VERSION_EPOCH_LEGACY);
  });

  it('не распознаёт мусор', () => {
    expect(versionEpoch('')).toBeNull();
    expect(versionEpoch('неизвестно')).toBeNull();
    expect(versionEpoch('3.x.0')).toBeNull();
  });
});

describe('compareAppVersion', () => {
  // Ради этого случая и заведён весь модуль: числами 3 < 2026, эпохами — наоборот.
  it('считает нумерацию поколения новее любого CalVer', () => {
    expect(compareAppVersion('3.1.0', '2026.814.1503')).toBe(1);
    expect(compareAppVersion('2026.814.1503', '3.1.0')).toBe(-1);
    expect(compareAppVersion('3.1.0', '2026.1231.2359')).toBe(1);
  });

  it('считает CalVer новее доисторических 1.x', () => {
    expect(compareAppVersion('2026.814.1503', '1.9.9')).toBe(1);
    expect(compareAppVersion('1.9.9', '2026.814.1503')).toBe(-1);
  });

  it('внутри эпохи сравнивает по числам слева направо', () => {
    expect(compareAppVersion('2026.814.1503', '2026.814.1140')).toBe(1);
    expect(compareAppVersion('2026.812.1551', '2026.814.1140')).toBe(-1);
    expect(compareAppVersion('3.2.0', '3.1.0')).toBe(1);
    expect(compareAppVersion('3.10.0', '3.9.0')).toBe(1);
    expect(compareAppVersion('4.1.0', '3.27.0')).toBe(1);
  });

  it('равные версии дают 0', () => {
    expect(compareAppVersion('3.1.0', '3.1.0')).toBe(0);
    expect(compareAppVersion('2026.814.1503', '2026.814.1503')).toBe(0);
  });

  it('терпит недостающие сегменты и префикс v', () => {
    expect(compareAppVersion('v3.1.0', '3.1')).toBe(0);
    expect(compareAppVersion('3.1.1', '3.1')).toBe(1);
  });

  it('на нераспознанной строке молчит, а не объявляет её устаревшей', () => {
    expect(compareAppVersion('3.1.0', 'мусор')).toBe(0);
    expect(compareAppVersion('мусор', '3.1.0')).toBe(0);
    expect(compareAppVersion('', '')).toBe(0);
  });
});

describe('parseGenerationVersion', () => {
  it('достаёт поколение и порядковый номер выпуска', () => {
    expect(parseGenerationVersion('3.1.0')).toEqual({ generation: 3, release: 1 });
    expect(parseGenerationVersion('3.27.0')).toEqual({ generation: 3, release: 27 });
    expect(parseGenerationVersion('4.5.0')).toEqual({ generation: 4, release: 5 });
  });

  it('не разбирает версии чужих схем и выпуск с нулём', () => {
    expect(parseGenerationVersion('2026.814.1503')).toBeNull();
    expect(parseGenerationVersion('1.55.0')).toBeNull();
    expect(parseGenerationVersion('3.0.0')).toBeNull();
    expect(parseGenerationVersion('мусор')).toBeNull();
  });
});

describe('nextGenerationVersion', () => {
  it('переход с CalVer открывает нумерацию с первого выпуска', () => {
    expect(nextGenerationVersion('2026.814.1503')).toBe(`${APP_GENERATION}.1.0`);
    expect(nextGenerationVersion('')).toBe(`${APP_GENERATION}.1.0`);
  });

  it('внутри поколения счёт идёт по единице', () => {
    expect(nextGenerationVersion('3.1.0')).toBe('3.2.0');
    expect(nextGenerationVersion('3.27.0')).toBe('3.28.0');
    expect(nextGenerationVersion('3.99.0')).toBe('3.100.0');
  });

  it('смена поколения начинает счёт выпусков заново', () => {
    expect(nextGenerationVersion('3.27.0', { bumpGeneration: true })).toBe('4.1.0');
    expect(nextGenerationVersion('2026.814.1503', { bumpGeneration: true })).toBe(`${APP_GENERATION + 1}.1.0`);
  });

  // Ради этого свойства нумерация и годится для самообновления.
  it('следующая версия всегда новее предыдущей', () => {
    for (const v of ['2026.814.1503', '3.1.0', '3.9.0', '3.99.0']) {
      expect(compareAppVersion(nextGenerationVersion(v), v)).toBe(1);
    }
  });
});

describe('formatAppVersionLabel / appProductName', () => {
  it('показывает версию так, как её называет владелец', () => {
    expect(formatAppVersionLabel('3.1.0')).toBe('Матрица3-РМЗ (1)');
    expect(formatAppVersionLabel('3.27.0')).toBe('Матрица3-РМЗ (27)');
    expect(formatAppVersionLabel('4.2.0')).toBe('Матрица4-РМЗ (2)');
  });

  it('клиенты на прежней схеме по-прежнему показываются датой сборки', () => {
    expect(formatAppVersionLabel('2026.814.1503')).toBe('14.08.2026 15:03');
    expect(formatAppVersionLabel('мусор')).toBe('мусор');
  });

  it('имя программы несёт номер поколения', () => {
    expect(appProductName('3.27.0')).toBe('Матрица3-РМЗ');
    expect(appProductName('4.1.0')).toBe('Матрица4-РМЗ');
    expect(appProductName()).toBe(`Матрица${APP_GENERATION}-РМЗ`);
  });
});
