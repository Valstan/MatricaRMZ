// Первый инструмент агента: «подготовить номера» — и он НЕ пишет.
//
// ЧТО ДЕЛАЕТ. Принимает данные в любом виде (список строкой, книга Excel, документ
// Word), разбирает их в номера двигателей и готовит список для СУЩЕСТВУЮЩЕГО окна
// «Добавить двигатели списком» (промт КАРМАНА #176, п. 8).
//
// ПОЧЕМУ НЕ ПИШЕТ. `productionProgram:saveRows` — это ПОЛНАЯ замена набора строк на
// сервере, а слияние с сервером и автосохранение живут в renderer. Запись из main
// стёрла бы несохранённую правку оператора (совет специалистов, разрез 2, п. 5).
// Значит, добавляет оператор — как сегодня, через `applyRows`, и запись остаётся одна.
//
// ПОЧЕМУ ПРАВИЛА НЕ ПЕРЕПИСАНЫ ЗДЕСЬ. Проверки дублей, неоднозначности и «отгружен»
// живут в домене (`shared/src/domain/productionProgramAddByNumbers.ts`), и их зовёт
// окно «Добавить списком» — то самое, куда уходит подготовленный список. Значит, у
// агента и у человека правило ОДНО.
//
// ЧТО УХОДИТ АГЕНТУ. Только СЧЁТ номеров: сами номера остаются на машине. Номера из
// файла — это данные оператора, и выкладывать их в облако мимо воли оператора не
// надо (вопрос владельца «что уходит в облако» — в плане нитки).

import { randomUUID } from 'node:crypto';

import {
  AGENT_PREPARED_ADD_FILE_UNREADABLE,
  AGENT_PREPARED_ADD_NO_NUMBERS,
  AGENT_PREPARED_ADD_TOO_MANY,
  ENGINE_BULK_INTAKE_MAX,
  PermissionCode,
  agentPreparedAddText,
  parseEngineBulkIntake,
  type AgentPreparedAddBatch,
} from '@matricarmz/shared';

import { readFileContentText, SourceReadError } from '../../fileContentReader.js';
import { auditAgentAction } from './audit.js';
import { rememberPreparedAdd } from './preparedAdd.js';
import type { AgentToolDefinition, AgentToolResult } from './types.js';

/** Код действия в журнале: семейство `agent.<домен>.<операция>`. */
export const AGENT_ACTION_PREPARE_ADD_BY_NUMBERS = 'agent.production_program.prepare_add_by_numbers';

/** Сколько номеров из одного файла берём за раз. */
const MAX_NUMBERS_PER_BATCH = ENGINE_BULK_INTAKE_MAX;

/** Прочитать данные: список строкой ИЛИ файл (Excel / Word / текст). */
async function readInputText(args: Record<string, unknown>): Promise<{ text: string; fromFile: boolean }> {
  const filePath = String(args.filePath ?? '').trim();
  const numbers = String(args.numbers ?? '').trim();
  if (!filePath) return { text: numbers, fromFile: false };
  try {
    const content = await readFileContentText(filePath);
    return { text: [numbers, content.text].filter(Boolean).join('\n'), fromFile: true };
  } catch (e) {
    if (e instanceof SourceReadError) {
      throw new Error(`${AGENT_PREPARED_ADD_FILE_UNREADABLE}: ${e.message}`);
    }
    throw e;
  }
}

export const prepareAddByNumbers: AgentToolDefinition = {
  id: 'productionProgram.prepareAddByNumbers',
  titleRu: 'Подготовить список двигателей для добавления',
  requires: [PermissionCode.ProductionProgramEdit],
  section: 'production_program',
  level: 'editor',
  // Канал действия: гейт раздела берётся по его имени — тот же, что у записи плана.
  channel: 'productionProgram:saveRows',
  descriptionRu:
    'Принимает номера двигателей (список строкой, книга Excel или документ Word) и готовит их ' +
    'для добавления в производственную программу списком. Ничего не записывает: список открывается ' +
    'в окне «Добавить двигатели списком», и добавляет оператор — там же видно, что добавлено и что отклонено.',
  inputSchema: {
    type: 'object',
    properties: {
      numbers: {
        type: 'string',
        description: 'Номера двигателей списком — строкой (пробел, запятая или с новой строки).',
      },
      filePath: {
        type: 'string',
        description: 'Путь к файлу на машине оператора с номерами (Excel, Word или текст).',
      },
      programId: {
        type: 'string',
        description: 'Программа, в которую пойдут номера. Не указан — текущая открытая.',
      },
    },
    additionalProperties: false,
  },
  handler: async (ctx, args): Promise<AgentToolResult> => {
    const { text } = await readInputText(args);
    const parsed = parseEngineBulkIntake(text);
    if (parsed.numbers.length === 0) {
      return { ok: false, error: AGENT_PREPARED_ADD_NO_NUMBERS };
    }
    if (parsed.numbers.length > MAX_NUMBERS_PER_BATCH) {
      return { ok: false, error: AGENT_PREPARED_ADD_TOO_MANY };
    }
    const programId = String(args.programId ?? '').trim() || null;
    const batch: AgentPreparedAddBatch = {
      id: `pp_add_${randomUUID()}`,
      programId,
      numbers: parsed.numbers,
      text: agentPreparedAddText(parsed.numbers),
      createdAt: Date.now(),
    };
    // След в журнале — ДО того, как список уйдёт в окно: действие агента видно
    // в аудите так же, как действие оператора (актёр — оператор, источник — агент).
    const audit = await auditAgentAction(ctx, {
      action: AGENT_ACTION_PREPARE_ADD_BY_NUMBERS,
      payload: {
        count: batch.numbers.length,
        repeated: parsed.repeated.length,
        programId: batch.programId,
      },
    });
    if (!audit.ok) return { ok: false, error: audit.error };
    rememberPreparedAdd(batch);
    return {
      ok: true,
      summary: `Подготовлено ${batch.numbers.length} номеров двигателей — список ждёт в окне «Добавить двигатели списком».`,
      data: { count: batch.numbers.length, repeated: parsed.repeated.length, programId: batch.programId },
      prepared: batch,
    };
  },
};
