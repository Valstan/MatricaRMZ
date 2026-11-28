// Форма инструмента агента — общий тип на реестр, гейт и канал действий.
//
// Отдельный файл — чтобы реестр и обработчик не импортировали друг друга: иначе
// между ними появляется цикл импортов, и порядок инициализации решает, что вызовет
// что раньше (ADR-0011 — про копии правил, но и про циклы здесь то же самое).

import type { AccessSection, AgentPreparedAddBatch, PermissionCode } from '@matricarmz/shared';

import type { IpcContext } from '../../../ipc/ipcContext.js';

/** Уровень доступа к разделу: наблюдатель или редактор. */
export type AgentToolLevel = 'viewer' | 'editor';

/** Аргументы действия — как их прислал агент. */
export type AgentToolArgs = Record<string, unknown>;

/** Ответ действия: сделано (с коротким итогом для агента) или отказ. */
export type AgentToolResult =
  | {
      ok: true;
      summary: string;
      data?: Record<string, unknown>;
      /**
       * Подготовленные данные для окна программы (список номеров). В ответ агенту
       * они НЕ уходят — только в окно: номера из файла выкладывать в облако нельзя.
       */
      prepared?: AgentPreparedAddBatch;
    }
  | { ok: false; error: string };

/** Объявление одного инструмента. */
export type AgentToolDefinition = {
  /** Имя инструмента для агента (MCP). */
  id: string;
  /** Название по-русски — им инструмент называется в интерфейсе и в журнале. */
  titleRu: string;
  /** Права оператора: без них действие не выполняется. */
  requires: PermissionCode[];
  /** Раздел доступа (тот же, что у гейта разделов). */
  section: AccessSection;
  /** Уровень доступа к разделу. */
  level: AgentToolLevel;
  /** Канал, которому соответствует действие: гейт раздела берётся по его имени. */
  channel: string;
  /** Описание для агента: что инструмент делает (MCP отдаёт его как есть). */
  descriptionRu: string;
  /** Схема аргументов (JSON Schema — как ждёт MCP). */
  inputSchema: Record<string, unknown>;
  /** Обработчик: зовёт те же сервисные функции, что и интерфейс. */
  handler: (ctx: IpcContext, args: AgentToolArgs) => Promise<AgentToolResult>;
};
