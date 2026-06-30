/**
 * Снимок редактируемого состояния карточки складского документа — для детекции
 * несохранённых изменений перед «Провести».
 *
 * «Провести» (postDocument) делает только переход статуса и НЕ пересохраняет строки/шапку,
 * поэтому несохранённые правки молча не попадают в проведённый документ. Снимок снимается
 * сразу после загрузки (baseline) и сравнивается с текущим перед проведением.
 *
 * Снимок строится из самого editable-state (а не из загруженного документа), поэтому
 * сравнение идёт «состояние против своего же baseline» — без проблем канонизации форматов
 * (дата как YYYY-MM-DD, цена как строка и т.п.). Любое изменение поля → другой снимок
 * (полнота: ложноотрицательных нет). Извлечено ради юнит-тестов.
 */

export type StockDocSnapshotLine = {
  nomenclatureId: string | null;
  qty: string;
  price: string;
  unit: string;
  batch: string;
  note: string;
  warehouseId: string | null;
  fromWarehouseId: string | null;
  toWarehouseId: string | null;
  bookQty: string;
  actualQty: string;
  adjustmentQty: string;
  reason: string;
};

export type StockDocSnapshotState = {
  docNo: string;
  docDate: string;
  docType: string;
  warehouseId: string | null;
  expectedDate: string;
  sourceType: string;
  sourceRef: string;
  contractId: string;
  reason: string;
  counterpartyId: string | null;
  lines: ReadonlyArray<StockDocSnapshotLine>;
};

export function buildStockDocumentSnapshot(state: StockDocSnapshotState): string {
  return JSON.stringify({
    docNo: state.docNo,
    docDate: state.docDate,
    docType: state.docType,
    warehouseId: state.warehouseId ?? null,
    expectedDate: state.expectedDate,
    sourceType: state.sourceType,
    sourceRef: state.sourceRef,
    contractId: state.contractId,
    reason: state.reason,
    counterpartyId: state.counterpartyId ?? null,
    // Массив (а не объект) — порядок строк значим: перестановка = изменение.
    lines: state.lines.map((l) => [
      l.nomenclatureId ?? null,
      l.qty,
      l.price,
      l.unit,
      l.batch,
      l.note,
      l.warehouseId ?? null,
      l.fromWarehouseId ?? null,
      l.toWarehouseId ?? null,
      l.bookQty,
      l.actualQty,
      l.adjustmentQty,
      l.reason,
    ]),
  });
}
