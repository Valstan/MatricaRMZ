import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Уменьшение интерфейса щипком (промт КАРМАНА #70, п.3): щипком можно не только
 * увеличить, но и уменьшить интерфейс НИЖЕ канона — чтобы всё стало мельче и
 * поместилось в экран.
 *
 * Ломается тихо: щипок вниз ничего не делает (WebView упирается в «страница и
 * так вписана в экран»), и оператор думает, что жеста нет. Сторож держит:
 * у WebView включены широкий вьюпорт и режим обзора, у viewport планшета задан
 * нижний предел масштаба меньше единицы, а канон (100 %) не сломан.
 */
const src = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');

const MAIN_ACTIVITY = src(
  '../../../../../android-app/android/app/src/main/java/ru/matricarmz/tablet/MainActivity.java',
);
const ANDROID_INDEX = src('../../../../../android-app/src/index.html');
const ELECTRON_INDEX = src('../../index.html');

describe('уменьшение интерфейса щипком на планшете', () => {
  it('WebView разрешает масштаб ниже вписанной ширины', () => {
    expect(MAIN_ACTIVITY, 'широкий вьюпорт выключен — уменьшить щипком нельзя').toContain(
      'settings.setUseWideViewPort(true)',
    );
    expect(MAIN_ACTIVITY, 'режим обзора выключен — уменьшить щипком нельзя').toContain(
      'settings.setLoadWithOverviewMode(true)',
    );
    expect(MAIN_ACTIVITY, 'зум WebView выключен совсем').toContain('settings.setSupportZoom(true)');
  });

  it('у viewport планшета задан нижний предел масштаба меньше канона', () => {
    const viewport = ANDROID_INDEX.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? '';
    expect(viewport, 'у планшета нет viewport с нижним пределом масштаба').toContain('initial-scale=1.0');
    expect(viewport, 'нижний предел масштаба не задан — уменьшить щипком нельзя').toContain('minimum-scale=0.5');
    expect(viewport, 'зум запрещён пресетом user-scalable').not.toContain('user-scalable=no');
  });

  it('канон 100 % и масштабирование щипком не запрещены', () => {
    const viewport = ANDROID_INDEX.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? '';
    expect(viewport, 'канон 100 % сбит').toContain('initial-scale=1.0');
    expect(viewport, 'щипок запрещён пресетом').not.toContain('user-scalable=no');
  });

  it('десктопный клиент не затронут: его viewport без нижнего предела', () => {
    const viewport = ELECTRON_INDEX.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? '';
    expect(viewport, 'десктопный viewport потерялся').toContain('initial-scale=1.0');
    expect(viewport, 'десктопному клиенту не нужен предел масштаба').not.toContain('minimum-scale');
  });
});
