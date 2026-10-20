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

  it('в форме — марка, дата прихода, контрагент, договор и большой список номеров', () => {
    expect(DIALOG).toContain('target="engine_brand"');
    expect(DIALOG).toContain('target="customer"');
    expect(DIALOG).toContain('target="contract"');
    expect(DIALOG).toContain('data-bulk-intake-arrival="true"');
    expect(DIALOG).toContain('data-bulk-intake-numbers="true"');
  });

  it('без контрагента или договора приём не начинается — оператору сказано, что делать', () => {
    expect(DIALOG).toContain('двигатели некуда добавить');
    expect(DIALOG).toContain('Создайте контрагента');
    expect(DIALOG).toContain('Сначала заведите договор');
    expect(DIALOG).toContain('В базе нет контрагентов');
    expect(DIALOG).toContain('В базе нет договоров');
  });

  it('превью и запись идут через main — гейты дублей одни на все входы', () => {
    expect(DIALOG).toContain('window.matrica.engines.bulkIntake');
    expect(DIALOG).toContain('.preview({ text })');
    expect(DIALOG).toContain('bulkIntake.apply({');
    expect(SERVICE).toContain('saveEngineCardGated');
    expect(SERVICE).not.toContain('db.insert(erpEngineCards)');
  });

  it('дублю предлагаются «пропустить» и «повторный заезд», третьего пути нет', () => {
    expect(DIALOG).toContain('Пропустить');
    expect(DIALOG).toContain('Повторный заезд');
    expect(DIALOG).toContain('previousEngineId: item.existing.id');
    expect(DIALOG).not.toContain('number_collision_flag');
  });

  it('повторный заезд ставит флаг и ссылку на прежний заезд', () => {
    expect(SERVICE).toContain('repeat_arrival_flag: true');
    expect(SERVICE).toContain('previous_arrival_id');
  });

  it('каждый заведённый двигатель занимает плановое место в договоре', () => {
    expect(DIALOG).toContain('placeEngineIntoContractSlot');
    expect(DIALOG).toContain('contract_section_number');
    expect(SLOT).toContain('mutateContractPayments');
    // Карточка двигателя ходит тем же путём — две копии логики разошлись бы.
    expect(CARD).toContain('placeEngineIntoContractSlotShared');
    expect(CARD).not.toContain('const r = await mutateContractPayments(targetContractId');
  });
});
