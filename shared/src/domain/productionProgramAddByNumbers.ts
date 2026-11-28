/**
 * «Добавить двигатели списком» в производственную программу — ДОМЕН.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Тело модалки (`ProductionProgramAddEnginesByNumbersDialog`)
 * было единственным местом, где живут правила: разбор номера, поиск карточки, отказ по
 * неоднозначности, отказ «уже в плане», отказ «отгружен». Как только действием агента
 * становится подготовка списка (промт КАРМАНА #176, разрез 2), у модалки появляется
 * ВТОРОЙ вызывающий — и любая правка правила в одном месте тихо разошлась бы с другим.
 * Значит, правило живёт здесь, а модалка и инструмент агента зовут его.
 *
 * ЧТО ЗДЕСЬ НЕ ДЕЛАЕТСЯ. Никаких запросов в базу и никакой записи: модуль чистый. Данные
 * (карточки двигателей, вид и номер договора, строки плана) приходят от вызывающего —
 * теми же путями, что и раньше (модалка читает их через IPC).
 *
 * ЗАПИСЬ. Сборка строк — только черновик (`ProductionProgramLineDraftDto`): запись в
 * производственную программу остаётся одной (`applyRows` на странице плана). Модуль
 * ничего не пишет и не знает про сервер.
 */
import type { ContractKind } from './contract.js';
import { parseEngineBulkIntake } from './engineBulkIntake.js';
import { looksLikeIdentifier } from './humanLabels.js';
import type { EngineListItem } from '../ipc/types.js';
import {
  PRODUCTION_PROGRAM_NO_CONTRACT_NUMBER_NOTE,
  PRODUCTION_PROGRAM_PENDING_GROUP_LABEL,
  productionProgramContractLabel,
  productionProgramEngineHint,
  productionProgramEngineIndex,
  productionProgramEngineMatch,
  productionProgramEngineProblem,
  productionProgramRowFromEngine,
  type ProductionProgramEngineIndex,
  type ProductionProgramLineDraftDto,
  type ProductionProgramLineDto,
} from './productionProgram.js';

/** Что будет с номером — три состояния. */
export type ProductionProgramAddByNumbersRowKind = 'normal' | 'pending' | 'forbidden';

/** Вид и номер договора — как их видит модалка (по одному запросу на договор). */
export type ProductionProgramAddByNumbersContractInfo = {
  kind: ContractKind | null;
  number: string;
};

/** Строка отчёта по одному номеру: что с ним и почему. */
export type ProductionProgramAddByNumbersReportRow = {
  /** Номер как ввёл оператор (ключ строки отчёта). */
  number: string;
  /** Карточка, если нашлась. */
  engine: EngineListItem | null;
  kind: ProductionProgramAddByNumbersRowKind;
  /** Причина словами: почему такой исход. */
  reason: string;
  /** Подсказка домена о состоянии двигателя (если отличается от причины). */
  hint: string;
  /** Подпись группы (организация и номер договора) — для отчёта. */
  groupLabel: string;
  contractKind: ContractKind | null;
  /** Номер повторился в этом же списке. */
  repeated: boolean;
};

/** Итог модалки: строки на добавление и отказы с причинами. */
export type ProductionProgramAddByNumbersResult = {
  /** Строки, которые надо добавить в план. */
  rows: Array<ProductionProgramLineDraftDto & { id: string }>;
  /** Сколько строк добавлено. */
  added: number;
  /** Отказы: номер и причина. */
  skipped: Array<{ label: string; reason: string }>;
  /** Строки программы с сервера на момент чтения — страница мержит с ними правку. */
  serverRows: ProductionProgramLineDto[];
};

/** Подпись двигателя в отчёте: марка и номер, а если карточки нет — сам номер. */
export function productionProgramAddByNumbersEngineLabel(
  engine: EngineListItem | null,
  number: string,
): string {
  if (!engine) return number;
  return [engine.engineBrand, engine.engineNumber].filter(Boolean).join(' ').trim() || number;
}

/**
 * Отчёт по каждому номеру списка: нашёлся ли двигатель, что с ним и куда попадёт.
 *
 * ЧИСТАЯ ФУНКЦИЯ: та же логика, что была в модалке, — неоднозначность («номер совпал с
 * несколькими карточками») в план не берётся, отгруженный не берётся, проблемная строка
 * ждёт в блоке «Требует данных».
 */
export function productionProgramAddByNumbersReport(input: {
  /** Текст со списком номеров (как вставил оператор). */
  text: string;
  /** Указатель по карточкам. Если не задан — строится по `engines`. */
  index?: ProductionProgramEngineIndex;
  /** Карточки двигателей (нужны, если указатель не передан). */
  engines?: readonly EngineListItem[];
  /** Вид и номер договора по id договора. */
  contractInfos: ReadonlyMap<string, ProductionProgramAddByNumbersContractInfo>;
  /**
   * Подпись группы по карточке — ОДИН источник правды со страницы программы
   * (номер договора приходит зеркалом позже карточки, и свой снимок отставал).
   */
  contractLabelOf?: (engine: EngineListItem) => string;
}): ProductionProgramAddByNumbersReportRow[] {
  const index = input.index ?? productionProgramEngineIndex(input.engines ?? []);
  const parsed = parseEngineBulkIntake(input.text);
  const repeated = new Set(parsed.repeated.map((n) => n.toLowerCase()));
  const out: ProductionProgramAddByNumbersReportRow[] = [];
  for (const number of parsed.numbers) {
    const match = productionProgramEngineMatch(index, number);
    const engine = match.engine;
    const hint = engine ? productionProgramEngineHint(engine) : null;
    if (match.ambiguous) {
      out.push({
        number,
        engine: null,
        kind: 'forbidden',
        reason: `Номер совпал с ${match.matches} карточками — выберите двигатель вручную`,
        hint: '',
        groupLabel: '',
        contractKind: null,
        repeated: repeated.has(number.toLowerCase()),
      });
      continue;
    }
    const problem = productionProgramEngineProblem(engine);
    const contractId = String(engine?.contractId ?? '');
    const info = input.contractInfos.get(contractId);
    const rawNumber = String(engine?.contractName ?? '').trim();
    const contractNumber = rawNumber && !looksLikeIdentifier(rawNumber) ? rawNumber : (info?.number ?? '');
    const ownLabel = engine
      ? productionProgramContractLabel({
          organization: engine.customerName ?? null,
          contractNumber,
        })
      : '';
    const groupLabel = engine ? (input.contractLabelOf?.(engine) ?? ownLabel) : '';
    const contractKind = info?.kind ?? null;
    let kind: ProductionProgramAddByNumbersRowKind = 'normal';
    let reason = problem.text;
    if (problem.forbidden) {
      kind = 'forbidden';
    } else if (problem.blocking) {
      kind = 'pending';
    } else if (!groupLabel) {
      // Договор есть, а шапку группы не из чего собрать (номер договора ещё не
      // доехал зеркалом) — строка ждёт в блоке и уедет сама, когда номер появится.
      kind = 'pending';
      reason = PRODUCTION_PROGRAM_NO_CONTRACT_NUMBER_NOTE;
    }
    out.push({
      number,
      engine,
      kind,
      reason,
      hint: hint && hint.text !== reason ? hint.text : '',
      groupLabel,
      contractKind,
      repeated: repeated.has(number.toLowerCase()),
    });
  }
  return out;
}

/**
 * Двигатель уже есть в плане? (по карточке и по номеру — номер может быть без карточки)
 *
 * ПРОВЕРКА ДУБЛЕЙ — здесь, в домене: и модалка, и действие агента зовут её. Своя копия
 * этой проверки в логике агента означала бы, что «дубли не создаются» — правда одной
 * копии правила, а не всей программы.
 */
export function productionProgramAddByNumbersAlreadyInProgram(
  row: ProductionProgramAddByNumbersReportRow,
  serverRows: readonly ProductionProgramLineDto[],
): boolean {
  const engineId = String(row.engine?.id ?? '');
  if (engineId && serverRows.some((l) => String(l.engineId ?? '') === engineId)) return true;
  const number = String(row.engine?.engineNumber ?? row.number).trim().toLowerCase();
  return serverRows.some((l) => String(l.engineNumber ?? '').trim().toLowerCase() === number);
}

/**
 * Строки плана из отмеченных номеров + отказы с причинами.
 *
 * ПРАВИЛО ОТКАЗОВ: «уже есть в плане» (дубль), «неоднозначно», «отгружен», «нет
 * карточки» — всё это здесь, а не в вызывающем. Порядок обхода тот же, что был в
 * модалке: сначала дубль, потом запрет, потом блок «Требует данных».
 */
export function productionProgramAddByNumbersRows(input: {
  /** Отмеченные строки отчёта (те, что оператор оставил включёнными). */
  report: readonly ProductionProgramAddByNumbersReportRow[];
  /** Строки плана с сервера на момент чтения — по ним ищется дубль. */
  serverRows: readonly ProductionProgramLineDto[];
  /** Идентификатор новой строки (вызывающий решает, чем он живёт). */
  makeId: () => string;
}): { rows: Array<ProductionProgramLineDraftDto & { id: string }>; skipped: Array<{ label: string; reason: string }> } {
  const rows: Array<ProductionProgramLineDraftDto & { id: string }> = [];
  const skipped: Array<{ label: string; reason: string }> = [];
  for (const row of input.report) {
    const label = productionProgramAddByNumbersEngineLabel(row.engine, row.number);
    if (productionProgramAddByNumbersAlreadyInProgram(row, input.serverRows)) {
      skipped.push({ label, reason: 'Уже есть в плане' });
      continue;
    }
    if (row.kind === 'forbidden') {
      skipped.push({ label, reason: row.reason });
      continue;
    }
    if (row.kind === 'pending') {
      // Проблемная строка: живёт в блоке «Требует данных» и сама уедет в свой
      // договор, когда карточку починят. Причина едет в примечание — и в печать.
      rows.push({
        id: input.makeId(),
        orderNo: 0,
        contractId: null,
        groupLabel: PRODUCTION_PROGRAM_PENDING_GROUP_LABEL,
        contractKind: null,
        engineId: row.engine ? String(row.engine.id) : null,
        engineMark: String(row.engine?.engineBrand ?? ''),
        engineNumber: String(row.engine?.engineNumber ?? row.number),
        state: null,
        shippingPlanAt: null,
        factors: '',
        note: row.reason,
      });
      continue;
    }
    if (!row.engine) {
      skipped.push({ label, reason: row.reason });
      continue;
    }
    rows.push(
      productionProgramRowFromEngine({
        id: input.makeId(),
        engine: row.engine,
        groupLabel: row.groupLabel,
        contractKind: row.contractKind,
      }),
    );
  }
  return { rows, skipped };
}
