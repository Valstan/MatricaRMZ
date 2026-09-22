import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож против шторма обновлений после синхронизации.
//
// Владелец 22.09.2026: «программа стала резко тяжелее, интерфейс тяжело работает на слабых
// компьютерах». Синк ходит на каждую правку и сыплет тиками 'progress'; на каждом таком тике
// раньше перечитывался весь список двигателей — полный скан EAV примерно по 1600 машинам плюс
// карта флагов инвентаря и история ремонтов. Список обязан перечитываться ОДИН раз, на 'done',
// и через коалесер — иначе импульс живых данных сразу после 'done' даёт второй такой же скан.
//
// Порвать это молча очень легко: строка `void refreshEngines()` в ветке прогресса выглядит
// безобидно, типы и линт останутся зелёными, а тяжесть вернётся.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const APP = src('./App.tsx');
const HOOK = src('./hooks/useLiveDataRefresh.ts');

const INCREMENTAL = APP.slice(APP.indexOf("if (evt.mode === 'incremental')"));
const PROGRESS_AT = INCREMENTAL.indexOf("if (evt.state === 'progress') {");
const DONE_AT = INCREMENTAL.indexOf("if (evt.state === 'done') {");
const progressBranch = INCREMENTAL.slice(PROGRESS_AT, DONE_AT);
const doneBranch = INCREMENTAL.slice(DONE_AT);

describe('ветки обработчика синка в App.tsx', () => {
  it('разбор исходника нашёл обе ветки — иначе сторож проверял бы пустую строку', () => {
    expect(INCREMENTAL.startsWith("if (evt.mode === 'incremental')")).toBe(true);
    expect(PROGRESS_AT).toBeGreaterThanOrEqual(0);
    expect(DONE_AT).toBeGreaterThan(PROGRESS_AT);
    expect(progressBranch).toContain('setSyncIndicator');
  });

  it('в ветке прогресса списка не перечитывают', () => {
    expect(progressBranch, 'вернулся скан списка на каждый тик синка').not.toContain('refreshEngines');
    expect(progressBranch, 'вернулся скан списка на каждый тик синка').not.toContain('requestEnginesRefresh');
  });

  it('в ветке прогресса не перезагружают открытую карточку', () => {
    expect(progressBranch, 'вернулась перезагрузка карточки на каждый тик синка').not.toContain('reloadEngine');
  });

  it('на done список перечитывается через коалесер, а не напрямую', () => {
    expect(doneBranch).toContain("requestEnginesRefresh('sync_done')");
  });
});

describe('стабильность обновления списка двигателей', () => {
  it('refreshEngines не пересоздаётся на каждый рендер', () => {
    expect(APP, 'refreshEngines снова обычная функция — подписки пересоздаются каждый рендер').toContain(
      'const refreshEngines = useCallback(',
    );
  });

  it('помощники сравнения списка живут вне компонента', () => {
    const componentAt = APP.indexOf('export function App() {');
    expect(componentAt).toBeGreaterThan(0);
    expect(APP.indexOf('function engineRowSignature(')).toBeLessThan(componentAt);
    expect(APP.indexOf('function sameEngineList(')).toBeLessThan(componentAt);
  });

  it('коалесер заведён на общем окне и проходит через perfTrace', () => {
    expect(APP).toContain('coalesceCalls<EnginesRefreshReason>');
    expect(APP).toContain('perfTrace.count(`engines.refresh:${reason}`)');
  });

  it('useLiveDataRefresh держит колбэк в ref — подписка не пересоздаётся на каждый рендер', () => {
    expect(HOOK).toContain('refreshRef.current = refresh;');
    expect(HOOK).toContain('await refreshRef.current();');
    const safeRefreshDeps = HOOK.match(/\}, \[enabled[^\]]*\]\);/)?.[0] ?? '';
    expect(safeRefreshDeps, 'refresh вернулся в зависимости safeRefresh').not.toContain('refresh,');
  });
});
