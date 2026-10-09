import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Карточка двигателя (баг 10.10.2026, = #1240 на контракте): синхронизация формы
// с БД пересиживала набранное при любой чужой записи в карточку (вложения, акты,
// операции — все обновляют updatedAt), потому что защита стояла на конъюнкции
// «черновик восстановлен И грязь»: снимок, созданный автосейвом уже в сессии
// (draftRestoredRef остаётся false), защиты не получал вовсе. Плюс отстали
// канон «Сброса» (dirty→clearDraft→load) и полнота «Отменить» (клеймо/цех/плоские
// поля уезжали в базу дифом при закрытии).
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const CARD = src('./EngineDetailsPage.tsx');

describe('карточка двигателя — фоновая синхронизация не трогает грязную форму', () => {
  it('guard эффекта-ресида — по одному флагу грязи', () => {
    expect(
      CARD,
      'вернулась конъюнкция с draftRestoredRef — автосейв-снимок остаётся без защиты',
    ).toContain('if (sessionHadChanges.current) return;');
    expect(CARD).not.toContain('if (draftRestoredRef.current && sessionHadChanges.current) return;');
  });

  it('автосейв помечает recovery-снимок существующим на диске', () => {
    expect(CARD, 'без этого первый фоновый ресид стирает набранное до применения черновика').toContain(
      'if (ok) draftRestoredRef.current = true;',
    );
  });

  it('«Отменить» добирает клеймо, год, цех и плоские реквизиты', () => {
    const norm = CARD;
    expect(norm, 'клеймо').toContain("setInternalNumber(String(attrs[ENGINE_INTERNAL_NUMBER_CODE] ?? ''));");
    expect(norm, 'год клейма').toContain('setInternalNumberYear(String(attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE]');
    expect(norm, 'цех').toContain("setWorkshopId(String(attrs.workshop_id ?? ''));");
    expect(norm, 'плоские реквизиты пересобираются из committed').toContain('setFlatValues(() => {');
  });

  it('«Сброс» гасит грязь, чистит черновик и гейт ДО перезагрузки', () => {
    const seq = [
      'setSessionChanged(false);',
      'cancelPendingDraftSave();',
      'await clearDraft();',
      'draftRestoredRef.current = false;',
      'await props.onReload();',
    ].join('\n      ');
    expect(CARD, 'порядок сброса разошёлся — черновик воскрешает сброшенное').toContain(seq);
  });

  it('closeWithoutSave отменяет таймер автосейва до стирания черновика', () => {
    expect(CARD).toContain('cancelPendingDraftSave();\n      setSessionChanged(false);\n      void clearDraft();');
  });
});

describe('вывод из утиля: картер отремонтирован/заменён (10.10.2026)', () => {
  it('на вкладке дефектовки есть действие с датой, исходом и применением', () => {
    expect(CARD, 'кнопка открытия').toContain('data-scrap-resolve-open');
    expect(CARD, 'исход «отремонтирован»').toContain("scrapResolveOutcome === 'repaired'");
    expect(CARD, 'исход «заменён»').toContain("scrapResolveOutcome === 'replaced'");
    expect(CARD, 'применение').toContain('data-scrap-resolve-apply');
  });

  it('действие пишет датированный след в историю ремонта и гасит флаги дверью карточки', () => {
    expect(CARD, 'след через общий билдер меты истории').toContain('buildRepairHistoryMeta({');
    expect(CARD, 'снятие утиля носит исход и момент события').toContain('scrapResolved: { outcome: scrapResolveOutcome, partLabel:');
    expect(CARD, 'запись истории — штатной операцией').toContain('window.matrica.operations.add(props.engineId, REPAIR_HISTORY_OPERATION_TYPE');
    expect(CARD, 'флаги гасятся через card.save, минуя EAV').toContain('engines?.card?.save?.({ id: props.engineId, fields: flagPatch })');
  });
});
