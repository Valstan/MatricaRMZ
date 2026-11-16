import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож против «очередь застряла, а программа молчит».
//
// Инцидент 16.11.2026: 617 строк `attribute_values` висели в `pending` неделями — оператор
// об этом не знал, сервер их не видел, автолечение скипалось с `daily_budget_exceeded`.
// Порвать это молча легко: убрать баннер или пробу — типы и линт останутся зелёными,
// а беда вернётся ровно та же.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const APP = src('./App.tsx');
const PROBE = src('../../../main/services/sync/localPending.ts');
const MANAGER = src('../../../main/services/syncManager.ts');

describe('застрявшие неотправленные строки видны', () => {
  it('оператору показывается баннер про очередь', () => {
    expect(APP).toContain('stuckPending');
    expect(APP).toContain('Записей не отправлено на сервер');
  });

  it('проба считает только pending и берёт возраст по времени правки строки', () => {
    expect(PROBE).toContain("sync_status = 'pending'");
    expect(PROBE).toContain('MIN(updated_at)');
    expect(PROBE).toContain('stuckPendingCutoff');
  });

  it('сводка доходит до статуса синка, который читает интерфейс', () => {
    expect(MANAGER).toContain('countStuckPendingLocalChanges');
    expect(MANAGER).toContain('stuckPending');
  });
});
