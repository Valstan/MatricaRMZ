import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// СТОРОЖ границы «нейросеть на клиенте» (промт КАРМАНА #176, разрез 2).
//
// Пять правил, каждое — про конкретный способ обойти границу:
//
//  1. Инструмент объявлен только в общем реестре (не в странице, не в отдельном
//     модуле под каждый раздел).
//  2. У каждого инструмента есть право и раздел — иначе действие ушло бы мимо прав.
//  3. Агент не пишет в реплику мимо моста: канал БД — только чтение.
//  4. Канал БД не умеет действий (иначе read-only мост перестал бы быть read-only).
//  5. В реестре нет НИ ОДНОГО собственного текста отказа: отказ говорит гейт
//     программы, а не реестр (иначе у правил появятся две формулировки).
//
// Сторож читает код текстом: правило держится НАПИСАНИЕМ, а не тестом поведения —
// иначе следующая правка тихо вернёт вторую копию правила.

const here = dirname(fileURLToPath(import.meta.url));

function src(rel: string): string {
  return readFileSync(join(here, rel), 'utf8').replace(/\r\n/g, '\n');
}

const REGISTRY = src('agentTools/registry.ts');
const GATE = src('agentTools/gate.ts');
const TYPES = src('agentTools/types.ts');
const AUDIT = src('agentTools/audit.ts');
const PREPARED = src('agentTools/preparedAdd.ts');
const TOOL = src('agentTools/prepareAddByNumbers.ts');
const RUNNER = src('agentRunner.ts');
const ACTION_BRIDGE = src('actionBridge.ts');
const DB_BRIDGE = src('dbBridge.ts');
const DB_MCP = src('../../../../resources/local-minimax/matrica-db-mcp.mjs');
const ACTIONS_MCP = src('../../../../resources/local-minimax/matrica-actions-mcp.mjs');
const SECTION_GATE = src('../../ipc/sectionGate.ts');
const SHARED_AUDIT_OBJECT = src('../../../../../shared/src/domain/auditObject.ts');
const SHARED_AUDIT_ACTION = src('../../../../../shared/src/labels/auditAction.ts');
const SHARED_ADD_BY_NUMBERS = src('../../../../../shared/src/domain/productionProgramAddByNumbers.ts');
const DIALOG = src('../../../renderer/src/ui/components/ProductionProgramAddEnginesByNumbersDialog.tsx');

/** Тексты отказа, которые принадлежат гейтам программы — их в реестре быть не должно. */
const GATE_REFUSAL_TEXTS = [
  'permission denied',
  'нет права',
  'Нет доступа к разделу',
  'view mode',
  'Раздел «',
  'обратитесь к администратору',
];

describe('граница «нейросеть на клиенте» — сторож', () => {
  it('инструмент объявлен только в общем реестре', () => {
    // Реестр — единственное место, где объявляют инструмент: ни в страницах, ни в
    // отдельных модулях «под раздел». Список MCP — тоже из реестра, второй копии нет.
    expect(REGISTRY).toContain('export const AGENT_TOOLS');
    expect(REGISTRY).toContain('agentToolMcpTools');
    expect(ACTIONS_MCP).toContain("type: 'tools'");
    // В MCP-сервере нет СВОЕГО списка инструментов — он спрашивает у приложения.
    expect(ACTIONS_MCP).not.toContain('productionProgram.prepareAddByNumbers');
    // Список инструментов собирается в одном месте: ни в гейте, ни в мосте, ни в
    // обработчике своего списка нет.
    expect(GATE).not.toContain('AGENT_TOOLS');
    expect(ACTION_BRIDGE).not.toContain('AGENT_TOOLS =');
    expect(TOOL).not.toContain('AGENT_TOOLS');
  });

  it('у каждого инструмента есть право и раздел', () => {
    expect(TYPES).toContain('requires: PermissionCode[]');
    expect(TYPES).toContain('section: AccessSection');
    expect(TYPES).toContain('level: AgentToolLevel');
    // Право агента = право сессии оператора: своих прав у агента нет.
    expect(REGISTRY).not.toMatch(/agent\.[a-z_]+\s*[:=]\s*'/);
    expect(TOOL).toContain('requires: [PermissionCode.ProductionProgramEdit]');
  });

  it('агент не пишет в реплику мимо моста', () => {
    // Мост к базе — только чтение: никаких инструментов записи там нет.
    expect(DB_BRIDGE).toContain('createSqliteReader');
    expect(DB_BRIDGE).not.toContain('runAgentTool');
    expect(DB_BRIDGE).not.toContain('AGENT_TOOLS');
    expect(DB_MCP).not.toContain("type: 'action'");
    expect(DB_MCP).not.toContain('saveRows');
  });

  it('канал БД не умеет действий', () => {
    // Мост БД знает только два типа запроса: список таблиц и чтение.
    expect(DB_BRIDGE).toContain("request.type === 'schema'");
    expect(DB_BRIDGE).toContain("request.type !== 'query'");
    expect(DB_BRIDGE).not.toContain("request.type === 'action'");
    // Действия идут отдельным каналом — отдельный токен, отдельный MCP-сервер.
    expect(ACTION_BRIDGE).toContain("request.type !== 'action'");
    expect(ACTION_BRIDGE).not.toContain('startLocalDbBridge');
    // В конфиге MCP прогона — два сервера: чтение и действия отдельно.
    expect(RUNNER).toContain('matrica-actions');
    expect(RUNNER).toContain('buildMcpConfig(req.dbMcp, req.actionsMcp)');
  });

  it('в реестре нет ни одного собственного текста отказа', () => {
    const files = { REGISTRY, GATE, TYPES, AUDIT, PREPARED, TOOL };
    for (const [name, text] of Object.entries(files)) {
      for (const phrase of GATE_REFUSAL_TEXTS) {
        expect(text, `${name}: свой текст отказа «${phrase}»`).not.toContain(phrase);
      }
    }
    // Отказы гейта — те же самые, что у дверей программы.
    expect(GATE).toContain('requirePermOrResult');
    expect(GATE).toContain('checkSectionAccess');
    expect(GATE).toContain('viewModeWriteError');
  });

  it('действие оборачивается тем же гейтом раздела, что и дверь', () => {
    expect(REGISTRY).toContain('createSectionIpcGate(ctx).wrap(');
    expect(REGISTRY).toContain('tool.channel');
    // Гейт разделов умеет проверять доступ ВНЕ IPC — один экспорт наружу.
    expect(SECTION_GATE).toContain('export async function checkSectionAccess');
  });

  it('след агентского действия в журнале: семейство agent.* и актёр-оператор', () => {
    expect(AUDIT).toContain("source: 'agent'");
    expect(TOOL).toContain('agent.production_program.prepare_add_by_numbers');
    expect(SHARED_AUDIT_OBJECT).toContain("['agent.', 'Нейросеть']");
    expect(SHARED_AUDIT_ACTION).toContain('agent.production_program.prepare_add_by_numbers');
    // Аудит — ДО записи: сначала след, потом действие.
    expect(TOOL.indexOf('await auditAgentAction(')).toBeLessThan(
      TOOL.indexOf('rememberPreparedAdd(batch)'),
    );
  });

  it('правило дублей живёт в домене, а не в модалке и не в логике агента', () => {
    expect(SHARED_ADD_BY_NUMBERS).toContain('productionProgramAddByNumbersAlreadyInProgram');
    expect(SHARED_ADD_BY_NUMBERS).toContain('productionProgramAddByNumbersRows');
    // Модалка зовёт домен, а не содержит правило сама.
    expect(DIALOG).toContain('productionProgramAddByNumbersReport');
    expect(DIALOG).toContain('productionProgramAddByNumbersRows');
    expect(DIALOG).not.toContain('productionProgramEngineProblem');
    expect(DIALOG).not.toContain('productionProgramEngineMatch');
    // И действие агента не переписывает правило: оно готовит список, а добавляет
    // оператор через существующее окно.
    expect(TOOL).not.toContain('productionProgramAddByNumbersRows');
  });
});
