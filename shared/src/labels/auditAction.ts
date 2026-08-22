/**
 * Человеческая подпись строки журнала действий.
 *
 * ПОЧЕМУ ЗДЕСЬ, А НЕ В `domain/`. Функция читает реестр подписей (`humanLabel`), а домену
 * импортировать реестр запрещено — он лист-потребитель, и обратный импорт даст ESM-цикл с
 * молча пустым реестром. Поэтому композиторы подписей живут отдельной папкой поверх домена.
 *
 * ПОЧЕМУ В `shared`, А НЕ НА СТРАНИЦЕ. Копий было две — `SuperadminAuditPage` в клиенте и
 * `AuditPage` в веб-админке. На момент выноса они совпадали дословно, и это как раз и есть
 * причина: держать две одинаковые копии в разных пакетах синхронными вручную нельзя, а по
 * одним и тем же данным два журнала обязаны показывать одно.
 *
 * ПОЧЕМУ НЕ ПРАВИТСЯ СЕРВЕР. `actionText` материализуется в колонку один раз при инжесте
 * (`statisticsAuditService`: вставка идёт `onConflictDoNothing`, а курсор — max(createdAt)),
 * поэтому исторические строки не переигрываются никогда. Подпись обязана считаться на показе.
 */
import { HUMAN_LABEL_OTHER, humanLabel } from '../domain/humanLabels.js';

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
  'part.create': 'Создал деталь',
  'part.update': 'Редактировал деталь',
  'part.delete': 'Удалил деталь',
  'supply_request.create': 'Создал заявку',
  'supply_request.update': 'Редактировал заявку',
  'supply_request.delete': 'Удалил заявку',
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
  // Коды, которые пишутся сегодня, но подписи не имели. Сервер для них кладёт в actionText
  // сам код, и панель истории документа печатала его дословно («ui.visit»). В журнале
  // админа код не всплывал: там раньше срабатывала ветка раздела.
  // `ui.card_open` сюда СОЗНАТЕЛЬНО не добавлен: хвостовая ветка знает и вид карточки, и
  // раздел («Открыл карточку двигателя «Д-100» в «Двигатели»»), а общая подпись их потеряла бы.
  'ui.visit': 'Открыл раздел',
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
  // Раздел на сервере объявлен NOT NULL и для нераспознанного действия равен «Прочее»,
  // поэтому непустым он приходит ВСЕГДА. Дописывать «в «Прочее»» к подписи бессмысленно —
  // это не раздел, а признак его отсутствия.
  const meaningfulSection = section && section !== HUMAN_LABEL_OTHER ? sectionLabel : '';
  const formatBySection = (actionText: string) => {
    if (targetLabel) return `${actionText} ${targetLabel}`;
    if (meaningfulSection) return `${actionText} в ${meaningfulSection}`;
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
    // Перечень полей есть только тогда, когда сервер дописал его ПОСЛЕ своей общей фразы
    // («Изменил карточку двигателя. Изменил: Марка»). Отрезать префикс через replace нельзя:
    // на строке без перечня («Изменил заявку») он не сработает, и фраза удвоится.
    const summary = /^изменил [^.]+\.\s*(.+)$/i.exec(fromText)?.[1]?.trim() ?? '';
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

  if (targetLabel) return `${openCard} ${targetLabel}${meaningfulSection ? ` в ${meaningfulSection}` : ''}`;
  if (meaningfulSection) return `Заходил в секцию ${meaningfulSection}`;
  // `fromText` здесь — это серверный actionText, а он для неизвестного действия равен САМОМУ
  // КОДУ. Поэтому подставлять его нельзя: получится «Выполнил действие: work_order.number_change».
  // Прочерк тут тоже не годится — это единственный смысл ячейки, потому общий текст.
  return 'Выполнил действие';
}
