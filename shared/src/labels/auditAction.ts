/**
 * Человеческая подпись строки журнала действий.
 *
 * ПОЧЕМУ ЗДЕСЬ, А НЕ В `domain/`. Функция читает реестр подписей (`humanLabel`), а домену
 * импортировать реестр запрещено — он лист-потребитель, и обратный импорт даст ESM-цикл с
 * молча пустым реестром. Поэтому композиторы подписей живут отдельной папкой поверх домена.
 *
 * ПОЧЕМУ В `shared`, А НЕ НА СТРАНИЦЕ. Копий было две — `SuperadminAuditPage` в клиенте и
 * `AuditPage` в веб-админке, — и они уже разъезжались. По одним и тем же данным два журнала
 * показывали бы разное.
 *
 * ПОЧЕМУ НЕ ПРАВИТСЯ СЕРВЕР. `actionText` материализуется в колонку один раз при инжесте
 * (`statisticsAuditService`: вставка идёт `onConflictDoNothing`, а курсор — max(createdAt)),
 * поэтому исторические строки не переигрываются никогда. Подпись обязана считаться на показе.
 */
import { humanLabel } from '../domain/humanLabels.js';

/**
 * Ровно те поля, которые читает подпись. Уже, чем строка журнала: панель истории документа
 * не знает `tableName` и `entityId`, и при `exactOptionalPropertyTypes` полный тип её отверг бы.
 */
export type AuditActionRow = {
  action?: string | null;
  actionText?: string | null;
  section?: string | null;
  documentLabel?: string | null;
  actionType?: string | null;
};

const EXACT_ACTION_BY_CODE: Record<string, string> = {
  'engine.create': 'Создал двигатель',
  'engine.update': 'Редактировал двигатель',
  'engine.delete': 'Удалил двигатель',
  'engine.edit_done': 'Редактировал двигатель',
  'ui.engine.edit_done': 'Редактировал двигатель',
  'part.create': 'Создал деталь',
  'part.update': 'Редактировал деталь',
  'part.delete': 'Удалил деталь',
  'supply_request.create': 'Создал заявку',
  'supply_request.update': 'Редактировал заявку',
  'supply_request.delete': 'Удалил заявку',
  'ui.supply_request.edit_done': 'Редактировал заявку',
  'employee.create': 'Создал сотрудника',
  'employee.update': 'Редактировал карточку сотрудника',
  'employee.delete': 'Удалил сотрудника',
  'tool.create': 'Добавил инструмент',
  'tool.update': 'Редактировал инструмент',
  'tool.delete': 'Удалил инструмент',
  'masterdata.create': 'Добавил запись справочника',
  'masterdata.update': 'Редактировал запись справочника',
  'masterdata.delete': 'Удалил запись справочника',
  'sync.create': 'Добавил запись синхронизации',
  'sync.update': 'Редактировал запись синхронизации',
  'sync.delete': 'Удалил запись синхронизации',
  'files.create': 'Добавил файл',
  'files.update': 'Редактировал файл',
  'files.delete': 'Удалил файл',
  // Пять кодов, которые пишутся сегодня и до этой таблицы не доходили: оператор видел их
  // дословно в хвостовом фолбэке («Выполнил действие: ui.visit»).
  'ui.visit': 'Открыл раздел',
  'ui.card_open': 'Открыл карточку',
  'ui.report_open': 'Открыл отчёт',
  'ui.report_build': 'Построил отчёт',
  'work_order.number_change': 'Сменил номер наряда',
};

const CREATE_BY_SECTION: Record<string, string> = {
  заявки: 'Создал заявку',
  двигатели: 'Добавил двигатель',
  детали: 'Добавил деталь',
  сотрудники: 'Создал сотрудника',
  инструменты: 'Добавил инструмент',
  справочники: 'Добавил запись справочника',
  синхронизация: 'Добавил запись синхронизации',
  файлы: 'Добавил файл',
};

const UPDATE_BY_SECTION: Record<string, string> = {
  заявки: 'Редактировал заявку',
  двигатели: 'Редактировал двигатель',
  детали: 'Редактировал деталь',
  сотрудники: 'Редактировал карточку сотрудника',
  инструменты: 'Редактировал инструмент',
  справочники: 'Редактировал запись справочника',
  синхронизация: 'Редактировал запись синхронизации',
  файлы: 'Редактировал файл',
};

const DELETE_BY_SECTION: Record<string, string> = {
  заявки: 'Удалил заявку',
  двигатели: 'Удалил двигатель',
  детали: 'Удалил деталь',
  сотрудники: 'Удалил сотрудника',
  инструменты: 'Удалил инструмент',
  справочники: 'Удалил запись справочника',
  синхронизация: 'Удалил запись синхронизации',
  файлы: 'Удалил файл',
};

const OPEN_BY_SECTION: Record<string, string> = {
  сотрудники: 'Открыл карточку сотрудника',
  заявки: 'Открыл заявку',
  детали: 'Открыл карточку детали',
  двигатели: 'Открыл карточку двигателя',
  инструменты: 'Открыл карточку инструмента',
  файлы: 'Открыл карточку файла',
  справочники: 'Открыл запись справочника',
  синхронизация: 'Открыл запись синхронизации',
};

/**
 * Наборы ДОСЛОВНЫХ серверных фраз — это ключ, а не текст. Строка, выпавшая из набора,
 * заставляет журнал печатать серверную формулировку вместо подписи по разделу, и падения
 * типов при этом нет. Менять их можно только вместе с производителем (`statisticsAuditService`).
 */
const GENERIC_BY_TYPE = {
  create: new Set([
    'создал запись',
    'создал запись.',
    'создал двигатель',
    'создал деталь',
    'создал заявку',
    'создал заявку.',
    'создал карточку двигателя',
  ]),
  update: new Set([
    'изменил запись',
    'изменил запись.',
    'изменил карточку двигателя',
    'изменил карточку двигателя.',
    'изменил заявку',
    'изменил заявку.',
    'изменил статус заявки',
  ]),
  delete: new Set([
    'удалил запись',
    'удалил запись.',
    'удалил деталь',
    'удалил деталь.',
    'удалил заявку',
    'удалил заявку.',
  ]),
};

export function describeAuditAction(row: AuditActionRow): string {
  const action = String(row.action ?? '')
    .trim()
    .toLowerCase();
  const fromText = String(row.actionText ?? '').trim();
  const section = String(row.section ?? '').trim();
  const target = String(row.documentLabel ?? '').trim();
  const normalizedFromText = fromText.toLowerCase();
  const sectionLabel = section ? `«${section}»` : '';
  const sectionLower = section.toLowerCase();
  const targetLabel = target ? `«${target}»` : '';
  const openCard = OPEN_BY_SECTION[sectionLower] || 'Открыл карточку';
  const formatBySection = (actionText: string) => {
    if (targetLabel) return `${actionText} ${targetLabel}`;
    if (sectionLabel) return `${actionText} в ${sectionLabel}`;
    return actionText;
  };

  if (action === 'app.session.start') return 'Зашел в систему';
  if (action === 'app.session.stop') return 'Вышел из системы';
  if (EXACT_ACTION_BY_CODE[action]) return formatBySection(EXACT_ACTION_BY_CODE[action]!);

  if (action === 'supply_request.transition') {
    const match = /^изменил статус заявки:\s*(.+?)\s*->\s*(.+)$/i.exec(fromText);
    if (match) {
      // Разбор серверного формата остаётся дословным — это контракт с производителем строки;
      // по-человечески подписывается только ВЫХОД, уже после захвата кодов.
      const from = humanLabel('supply_request_status', String(match[1] ?? '').trim());
      const to = humanLabel('supply_request_status', String(match[2] ?? '').trim());
      const statusTarget = target || sectionLabel ? `по ${target ? targetLabel : sectionLabel}` : '';
      return `Сменил статус заявки${statusTarget ? ` ${statusTarget}` : ''}: ${from} → ${to}`;
    }
  }
  if (action.endsWith('.edit_done')) {
    const base = formatBySection(UPDATE_BY_SECTION[sectionLower] || 'Редактировал');
    const summary = fromText.replace(/^изменил [^.]+\.\s*/i, '').trim();
    return summary ? `${base}. ${summary}` : base;
  }
  if (action.includes('.open') || action.includes('.view') || action.includes('.details')) {
    const actionPhrase = OPEN_BY_SECTION[sectionLower] || 'Открыл страницу';
    if (targetLabel) return `${actionPhrase} ${targetLabel}${section ? ` в ${sectionLabel}` : ''}`;
    if (sectionLabel) return `${actionPhrase} в ${sectionLabel}`;
    return 'Открыл страницу';
  }

  if (row.actionType === 'create') {
    if (fromText && !GENERIC_BY_TYPE.create.has(normalizedFromText)) return fromText;
    return formatBySection(CREATE_BY_SECTION[sectionLower] || 'Создал');
  }

  if (row.actionType === 'update') {
    if (fromText && !GENERIC_BY_TYPE.update.has(normalizedFromText)) return fromText;
    return formatBySection(UPDATE_BY_SECTION[sectionLower] || 'Редактировал');
  }

  if (row.actionType === 'delete') {
    if (fromText && !GENERIC_BY_TYPE.delete.has(normalizedFromText)) return fromText;
    return formatBySection(DELETE_BY_SECTION[sectionLower] || 'Удалил');
  }

  if (targetLabel) return `${openCard} ${targetLabel}${section ? ` в ${sectionLabel}` : ''}`;
  if (sectionLabel) return `Заходил в секцию ${sectionLabel}`;
  if (fromText) return `Выполнил действие: ${fromText}`;
  // Прежде здесь стоял эхо-фолбэк `Выполнил действие: ${action}` — единственное место, где
  // журнал показывал служебный код. Прочерк тут не годится: это единственный смысл ячейки.
  return 'Выполнил действие';
}
