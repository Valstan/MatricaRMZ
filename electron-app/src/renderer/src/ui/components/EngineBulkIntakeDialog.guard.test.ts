import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIALOG = readFileSync(resolve(__dirname, './EngineBulkIntakeDialog.tsx'), 'utf-8');
const PAGE = readFileSync(resolve(__dirname, '../pages/EnginesPage.tsx'), 'utf-8');
const SERVICE = readFileSync(resolve(__dirname, '../../../../main/services/engineBulkIntakeService.ts'), 'utf-8');
const SLOT = readFileSync(resolve(__dirname, '../utils/engineContractSlot.ts'), 'utf-8');
const CARD = readFileSync(resolve(__dirname, '../pages/EngineDetailsPage.tsx'), 'utf-8');

describe('EngineBulkIntakeDialog — приём двигателей списком', () => {
  it('над списком двигателей есть кнопка приёма пачки', () => {
    expect(PAGE).toContain('Принять двигатели списком');
    expect(PAGE).toContain('EngineBulkIntakeDialog');
    expect(PAGE).toContain('canViewMasterData={props.canViewMasterData === true}');
  });

  it('в форме — марка, дата прихода, контрагент, договор, дата дефектовки и список номеров', () => {
    expect(DIALOG).toContain('target="engine_brand"');
    expect(DIALOG).toContain('target="customer"');
    expect(DIALOG).toContain('target="contract"');
    expect(DIALOG).toContain('data-bulk-intake-arrival="true"');
    expect(DIALOG).toContain('data-bulk-intake-defect="true"');
    expect(DIALOG).toContain('data-bulk-intake-numbers="true"');
  });

  it('все поля необязательны: обязательных подписей и отказов «некуда добавить» нет', () => {
    expect(DIALOG).not.toContain('Марка двигателя *');
    expect(DIALOG).not.toContain('Дата прихода *');
    expect(DIALOG).not.toContain('Контрагент *');
    expect(DIALOG).not.toContain('Номер договора *');
    expect(DIALOG).not.toContain('Номера двигателей *');
    expect(DIALOG).not.toContain('двигатели некуда добавить');
    expect(DIALOG).toContain('Все поля ниже — по желанию');
    // Пустые справочники больше не блокируют приём — предупреждаем, что свяжется позже.
    expect(DIALOG).toContain('В базе нет контрагентов');
    expect(DIALOG).toContain('В базе нет договоров');
  });

  it('внутренний номер вводится построчно — один на пачку не бывает (пара номер+год уникальна)', () => {
    expect(DIALOG).toContain('data-bulk-intake-internal="true"');
    expect(DIALOG).toContain('internalNumber: item.rawInternal.trim()');
  });

  it('превью и запись идут через main — гейты дублей одни на все входы', () => {
    expect(DIALOG).toContain('window.matrica.engines.bulkIntake');
    expect(DIALOG).toContain('.preview({ text })');
    expect(DIALOG).toContain('bulkIntake.apply({');
    expect(SERVICE).toContain('saveEngineCardGated');
    expect(SERVICE).not.toContain('db.insert(erpEngineCards)');
  });

  it('дублю предлагаются «пропустить», «обновить» и «повторный заезд»', () => {
    expect(DIALOG).toContain('Пропустить');
    expect(DIALOG).toContain('Обновить');
    expect(DIALOG).toContain('Повторный заезд');
    expect(DIALOG).toContain("action: 'update'");
    expect(DIALOG).toContain('previousEngineId: item.existing.id');
    expect(DIALOG).not.toContain('number_collision_flag');
  });

  it('«обновить» дописывает только недостающее — и main, и форма считают одно и то же', () => {
    expect(SERVICE).toContain('engineBulkIntakeMissingFields');
    expect(DIALOG).toContain('engineBulkIntakeMissingFields');
    expect(DIALOG).toContain('engineBulkIntakeConflictingFields');
    expect(DIALOG).toContain('не хватает:');
    expect(DIALOG).toContain('всё уже есть');
    // Дописываем только пустое: заполненное в карточке не перезаписываем.
    expect(DIALOG).toContain('не перезаписываю');
  });

  it('дата дефектовки ставится этапом «Разборка/Дефектовка», а не полем карточки', () => {
    expect(SERVICE).toContain('disassembly_defect');
    expect(SERVICE).toContain('ensureRepairStageRow');
    expect(SERVICE).toContain('defectStageMissed');
    expect(SERVICE).not.toContain("fields.defect_date");
    expect(DIALOG).toContain('Разборка/Дефектовка');
  });

  it('повторный заезд ставит флаг и ссылку на прежний заезд', () => {
    expect(SERVICE).toContain('repeat_arrival_flag');
    expect(SERVICE).toContain('previous_arrival_id');
  });

  it('каждый заведённый двигатель занимает плановое место в договоре', () => {
    expect(DIALOG).toContain('placeEngineIntoContractSlot');
    expect(DIALOG).toContain('contract_section_number');
    expect(DIALOG).toContain('contractedIds');
    expect(SLOT).toContain('mutateContractPayments');
    // Карточка двигателя ходит тем же путём — две копии логики разошлись бы.
    expect(CARD).toContain('placeEngineIntoContractSlotShared');
    expect(CARD).not.toContain('const r = await mutateContractPayments(targetContractId');
  });

  it('«входной контроль ОТК» — одна дата на приход, акт комплектности и этап (владелец 21.10.2026)', () => {
    expect(DIALOG).toContain('Входной контроль ОТК');
    expect(DIALOG).toContain('Одна дата на три действия');
    // Акт идёт штатным путём актов, а не прямой записью в operations.
    const IPC = readFileSync(resolve(__dirname, '../../../../main/ipc/register/engineBulkIntake.ts'), 'utf-8');
    expect(IPC).toContain('saveRepairChecklistForEngine');
    expect(IPC).toContain('completeness_inspection_date');
    expect(IPC).toContain('incoming_otk');
    expect(SERVICE).toContain('otkMissed');
    expect(PAGE).toContain('входной контроль ОТК не создан');
  });

  it('блок «индивидуально по каждому»: марка, ОТК, накладная и дата дефектовки построчно', () => {
    expect(DIALOG).toContain('data-bulk-intake-individual="true"');
    expect(DIALOG).toContain('Индивидуально по каждому');
    expect(DIALOG).toContain('data-bulk-intake-row-otk="true"');
    expect(DIALOG).toContain('data-bulk-intake-row-waybill="true"');
    expect(DIALOG).toContain('data-bulk-intake-row-defect="true"');
    expect(DIALOG).toContain('incomingOtkDate');
    expect(DIALOG).toContain('waybillNumber');
    expect(SERVICE).toContain('arrival_invoice');
  });

  it('по умолчанию у заведённого двигателя «Обновить», а не «Пропустить»', () => {
    expect(DIALOG).toContain('effectiveEngineBulkIntakeAction');
    // Порядок кнопок в строке: Обновить → Повторный заезд → Пропустить.
    const updateAt = DIALOG.search(/>\s*Обновить\s*</);
    const repeatAt = DIALOG.search(/>\s*Повторный заезд\s*</);
    const skipAt = DIALOG.search(/>\s*Пропустить\s*</);
    expect(updateAt).toBeGreaterThan(0);
    expect(repeatAt).toBeGreaterThan(updateAt);
    expect(skipAt).toBeGreaterThan(repeatAt);
  });

  it('похожие номера подсказываются и дают привязать строку вместо двойника', () => {
    expect(DIALOG).toContain('возможно, опечатка');
    expect(DIALOG).toContain('setBindings');
    expect(DIALOG).toContain('item.binding?.engineNumber');
    expect(SERVICE).toContain('engineBulkIntakeSimilarNumbers');
  });

  it('утиль верхнего картера — галочка строки, а строка берётся из марки тем же построителем', () => {
    expect(DIALOG).toContain('data-bulk-intake-row-scrap="true"');
    expect(DIALOG).toContain('markUpperCarterScrap');
    expect(DIALOG).toContain('buildBrandRowsForStage');
    expect(DIALOG).toContain('markScrapRow');
    expect(DIALOG).toContain('scrapMissing');
    expect(PAGE).toContain('утиль верхнего картера не поставлен');
  });
});
