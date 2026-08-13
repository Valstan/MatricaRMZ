/**
 * Плоские поля карточки двигателя: накладные, дефектовка, примечание и блок
 * отчётных документов. Однотипные, поэтому описаны таблицей — по ней идут и
 * регистрация `attribute_defs` в карточке, и запись из скрипта импорта.
 *
 * Таблица живёт здесь, а не в карточке, ровно затем, чтобы копий не было двух:
 * скрипт, заводящий недостающие defs, и карточка обязаны понимать поля одинаково.
 */
export type EngineFlatFieldKind = 'text' | 'date' | 'bool';

export type EngineFlatField = {
  code: string;
  label: string;
  kind: EngineFlatFieldKind;
  order: number;
};

/** Вкладка «Основное»: каждое поле стоит рядом со «своей» датой. */
export const ENGINE_EXTRA_MAIN_FIELDS: readonly EngineFlatField[] = [
  { code: 'arrival_invoice', label: 'Номер накладной (приход)', kind: 'text', order: 51 },
  { code: 'defect_date', label: 'Дата дефектовки', kind: 'date', order: 52 },
  { code: 'shipment_invoice', label: 'Номер накладной (отгрузка)', kind: 'text', order: 71 },
  { code: 'engine_note', label: 'Примечание', kind: 'text', order: 79 },
];

/** Вкладка «Отчётные документы». Пары «скан/оригинал» и «отправка/возврат»
 * в исходной таблице записаны одной ячейкой через слэш — здесь это два поля. */
export const ENGINE_DOC_FIELDS: readonly EngineFlatField[] = [
  { code: 'docs_state', label: 'Состояние', kind: 'text', order: 100 },
  { code: 'docs_aspvr_contractor_date', label: 'Подписан АСПВР исполнителем', kind: 'date', order: 101 },
  { code: 'docs_vp_sent_date', label: 'Отправка ВП', kind: 'date', order: 102 },
  { code: 'docs_vp_returned_date', label: 'Возврат ВП', kind: 'date', order: 103 },
  { code: 'docs_aspvr_customer_scan_date', label: 'АСПВР заказчику — скан', kind: 'date', order: 104 },
  { code: 'docs_aspvr_customer_original_date', label: 'АСПВР заказчику — оригинал', kind: 'date', order: 105 },
  { code: 'docs_track_or_act', label: 'Трек-номер или акт приёма-передачи', kind: 'text', order: 106 },
  { code: 'docs_aspvr_signed_customer_date', label: 'Подписан АСПВР заказчиком', kind: 'date', order: 107 },
  // В источнике вместо даты подписания часто стоит просто «получен»: дата неизвестна,
  // а факт получения известен — держим его галочкой, а не текстом в поле даты.
  { code: 'docs_aspvr_customer_received', label: 'Получен', kind: 'bool', order: 108 },
  { code: 'docs_return_scan_date', label: 'Возврат от заказчика — скан', kind: 'date', order: 109 },
  { code: 'docs_return_original_date', label: 'Возврат от заказчика — оригинал', kind: 'date', order: 110 },
  { code: 'docs_note', label: 'Примечание по документам', kind: 'text', order: 111 },
];

export const ENGINE_FLAT_FIELDS: readonly EngineFlatField[] = [
  ...ENGINE_EXTRA_MAIN_FIELDS,
  ...ENGINE_DOC_FIELDS,
];
