// Четыре причины отказа — и четыре РАЗНЫХ слова (промт КАРМАНА #142, п.4).
//
// Зачитка владельца 25.11.2026: «недостаточно прав». Разбор показал: дело не в
// правах, а в том, что отказ выглядел одинаково при разных причинах, и оператор
// (и админ, к которому он придёт) гадали, чего не хватает. Список причин:
//   1. канал на этой платформе не заведён — «канал не заведён на планшете: … — <причина>»;
//   2. нет права — «permission denied: <право> — нет права «<право>»»;
//   3. нет доступа к разделу — «Нет доступа к разделу «…»»;
//   4. нужна сеть — «нужна сеть: …».
//
// Проверка идёт через НАСТОЯЩИЙ мост (preload → шина → register → сервисы):
// замокан только сервер и SQLite-платформа.
import { afterEach, describe, expect, it } from 'vitest';

import { startBridgeHarness, PERMS, type BridgeHarness } from './testing/bridgeHarness.js';

/**
 * Текст отказа так, как его увидит оператор.
 *
 * Формы ответа разные, и это нормально: часть каналов возвращает `{ok:false,
 * error}`, а гейт разделов и сетевые сбои приходят ОТКАЗОМ (исключением) — renderer
 * ловит его и показывает «Ошибка сохранения: <текст>». Оператор видит текст в
 * обоих случаях, поэтому и проверяем текст.
 */
async function refusalText(fn: () => Promise<unknown>): Promise<{ ok: boolean; text: string }> {
  try {
    const res = (await fn()) as { ok?: unknown; error?: unknown } | null;
    const ok = res?.ok === true;
    return { ok, text: ok ? '' : String(res?.error ?? '') };
  } catch (e) {
    return { ok: false, text: String((e as Error)?.message ?? e) };
  }
}

describe('причины отказа различаются', () => {
  let h: BridgeHarness | null = null;

  afterEach(async () => {
    await h?.dispose();
    h = null;
  });

  it('1. канал не заведён на платформе — с названной причиной', async () => {
    h = await startBridgeHarness();
    const res = await refusalText(() => h!.matrica().files.pick());
    expect(res.ok).toBe(false);
    expect(res.text).toContain('канал не заведён на планшете');
    // Причина названа: иначе это снова выглядит как «недостаточно прав».
    expect(res.text.length, 'отказ без причины').toBeGreaterThan('канал не заведён на планшете'.length + 10);
  });

  it('2. нет права — называет право, а не «доступ к разделу»', async () => {
    // Права копируются в сессию при входе, поэтому право убирают ДО входа.
    const saved = PERMS['reports.view'];
    delete PERMS['reports.view'];
    try {
      h = await startBridgeHarness();
      const res = await refusalText(() => h!.matrica().reports.presetList());
      expect(res.ok).toBe(false);
      expect(res.text).toContain('reports.view');
      expect(res.text).not.toContain('Нет доступа к разделу');
      expect(res.text).not.toContain('канал не заведён');
    } finally {
      if (saved) PERMS['reports.view'] = saved;
    }
  });

  it('3. нет доступа к разделу — называет раздел, а не право', async () => {
    // Раздел «Склад» выдан, «Производство» — нет: гейт разделов отказывает
    // по разделу, и это НЕ то же самое, что «нет права».
    h = await startBridgeHarness({
      sectionMembership: [{ login: 'verify', sectionId: 'warehouse', level: 'viewer' }],
    });
    const res = await refusalText(() => h!.matrica().engines.card.get('e-1'));
    expect(res.ok).toBe(false);
    expect(res.text).toContain('Нет доступа к разделу');
    expect(res.text).toContain('Производство');
    expect(res.text).not.toContain('канал не заведён');
  });

  it('4. нужна сеть — называет сеть, а не раздел и не право', async () => {
    h = await startBridgeHarness({ offlineAfterLogin: true });
    const res = await refusalText(() => h!.matrica().timesheets.list());
    expect(res.ok).toBe(false);
    expect(res.text).toContain('нужна сеть');
    expect(res.text).not.toContain('Нет доступа к разделу');
    expect(res.text).not.toContain('канал не заведён');
  });
});
