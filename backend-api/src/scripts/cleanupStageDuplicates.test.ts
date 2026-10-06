import { describe, expect, it } from 'vitest';

import {
  parseEavDate,
  pickArrivalKeeper,
  sheetTwinStageCode,
  stageAuthorAfterMerge,
  stageNoteAfterMerge,
  stageNoteFromSheetNote,
} from './cleanupStageDuplicates.js';

// Чистка дублей этапов (решение владельца 06.10.2026): правила решений — чистые
// функции, чтобы список к удалению считал тест, а не глаз на dry-run.

describe('sheetTwinStageCode', () => {
  it('известные узлы карты переноса → код этапа', () => {
    expect(sheetTwinStageCode('ukladka')).toBe('ukladka');
    expect(sheetTwinStageCode('sborka')).toBe('sborka');
    expect(sheetTwinStageCode('obkatka')).toBe('obkatka');
    expect(sheetTwinStageCode('priemka_otk')).toBe('otk');
  });

  it('«Вал» и свои узлы этапами не были — пары нет', () => {
    expect(sheetTwinStageCode('val')).toBeNull();
    expect(sheetTwinStageCode('свой_узел')).toBeNull();
    expect(sheetTwinStageCode('')).toBeNull();
  });
});

describe('pickArrivalKeeper — канон даты приёмки: карточка', () => {
  it('карточка совпала со второй строкой — живая вторая', () => {
    expect(pickArrivalKeeper(['2026-07-03', '2026-07-06'], '2026-07-06')).toBe(1);
  });

  it('карточка совпала с первой — живая первая', () => {
    expect(pickArrivalKeeper(['2026-09-11', '2026-09-21'], '2026-09-11')).toBe(0);
  });

  it('даты карточки нет или она не совпала — решение не принимаем', () => {
    expect(pickArrivalKeeper(['2026-09-11', '2026-09-21'], null)).toBeNull();
    expect(pickArrivalKeeper(['2026-09-11', '2026-09-21'], '2026-09-15')).toBeNull();
  });
});

describe('stageAuthorAfterMerge — человек важнее скрипта', () => {
  it('у живой автор-скрипт, у старой человек → переносим человека', () => {
    expect(stageAuthorAfterMerge('stages:backfill', 'sapegin')).toBe('sapegin');
  });

  it('у живой уже человек — не трогаем', () => {
    expect(stageAuthorAfterMerge('sapegin', 'valstan')).toBeNull();
  });

  it('у старой тоже служебный/пусто — нечего переносить', () => {
    expect(stageAuthorAfterMerge('stages:backfill', 'stages:backfill')).toBeNull();
    expect(stageAuthorAfterMerge('stages:backfill', '')).toBeNull();
    expect(stageAuthorAfterMerge('stages:backfill', 'local')).toBeNull();
  });
});

describe('stageNoteAfterMerge — примечание со старой не теряется', () => {
  it('у живой пусто, у старой есть → переносим', () => {
    expect(stageNoteAfterMerge('', 'Обкатан')).toBe('Обкатан');
  });

  it('у живой есть — чужое не перетираем', () => {
    expect(stageNoteAfterMerge('моя заметка', 'Обкатан')).toBeNull();
  });

  it('обе пустые — нечего менять', () => {
    expect(stageNoteAfterMerge('', '')).toBeNull();
  });
});

describe('stageNoteFromSheetNote — служебная строка старого формата', () => {
  it('«Этап работ: …» → «Этап: …» каноническим именем', () => {
    expect(stageNoteFromSheetNote('Этап работ: Приёмка ОТК', 'Выходной контроль ОТК')).toBe(
      'Этап: Выходной контроль ОТК',
    );
    expect(stageNoteFromSheetNote('Этап работ: Укладка вала в картер · сделано', 'Укладка вала')).toBe(
      'Этап: Укладка вала · сделано',
    );
  });

  it('чужой текст и пусто — не трогаем', () => {
    expect(stageNoteFromSheetNote('Обкатан', 'Обкатка двигателя')).toBeNull();
    expect(stageNoteFromSheetNote('', 'Обкатка двигателя')).toBeNull();
  });
});

describe('parseEavDate — обе формы value_json', () => {
  it('число и строка-число', () => {
    expect(parseEavDate(1788814800000)).toBe(1788814800000);
    expect(parseEavDate('1788814800000')).toBe(1788814800000);
  });

  it('объект {kind:"date", value}', () => {
    expect(parseEavDate('{"kind":"date","value":1789938000000}')).toBe(1789938000000);
  });

  it('мусор → null (не выдумываем дату)', () => {
    expect(parseEavDate(null)).toBeNull();
    expect(parseEavDate('')).toBeNull();
    expect(parseEavDate('{"kind":"date"}')).toBeNull();
    expect(parseEavDate('не дата')).toBeNull();
  });
});
