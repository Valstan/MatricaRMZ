import { Router } from 'express';
import { z } from 'zod';
import {
  and,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import ExcelJS from 'exceljs';

import type {
  ReportBuilderColumnMeta,
  ReportBuilderFilter,
  ReportBuilderFilterCondition,
  ReportBuilderFilterGroup,
  ReportBuilderOperator,
  ReportBuilderPreviewTable,
} from '@matricarmz/shared';
import { PermissionCode } from '../auth/permissions.js';
import { getEffectivePermissionsForUser } from '../auth/permissions.js';
import { type AuthenticatedRequest } from '../auth/middleware.js';
import { db } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  auditLog,
  ledgerTxIndex,
  changeRequests,
  chatMessages,
  chatReads,
  clientSettings,
  diagnosticsSnapshots,
  entities,
  entityTypes,
  fileAssets,
  noteShares,
  notes,
  operations,
  permissionDelegations,
  permissions,
  refreshTokens,
  rowOwners,
  syncState,
  userPermissions,
  userPresence,
  users,
} from '../database/schema.js';

export const reportsRouter = Router();

type ColumnSpec = ReportBuilderColumnMeta & { col: any };
type TableSpec = {
  name: string;
  label: string;
  permission: string[];
  table: any;
  columns: ColumnSpec[];
};

const HIDDEN_COLUMN_IDS = new Set([
  'syncstatus',
  'deletedat',
  'payloadjson',
  'metajson',
  'passwordhash',
  'tokenhash',
  'localrelpath',
  'yandexdiskpath',
  'previewlocalrelpath',
  'previewmime',
  'previewsize',
  'rowid',
  'serverseq',
  'typeid',
  'entitytypeid',
  'entityid',
  'attributedefid',
]);

function isHiddenColumn(id: string) {
  const key = String(id || '').toLowerCase();
  if (HIDDEN_COLUMN_IDS.has(key)) return true;
  if (key.endsWith('hash')) return true;
  if (key.endsWith('path')) return true;
  return false;
}

function visibleColumns(table: TableSpec): ColumnSpec[] {
  return table.columns.filter((c) => !isHiddenColumn(c.id));
}

function entityTypeNameSql(typeIdCol: any) {
  return sql`(select et.name from entity_types et where et.id = ${typeIdCol} and et.deleted_at is null limit 1)`;
}

function entityTypeNameByEntityIdSql(entityIdCol: any) {
  return sql`(select et.name
    from entities e
    join entity_types et on et.id = e.type_id
    where e.id = ${entityIdCol} and e.deleted_at is null and et.deleted_at is null
    limit 1)`;
}

function entityDisplayNameSql(entityIdCol: any) {
  return sql`(select trim(both '"' from av.value_json)
    from attribute_values av
    join attribute_defs ad on ad.id = av.attribute_def_id
    where ad.code = 'name' and ad.deleted_at is null
      and av.entity_id = ${entityIdCol} and av.deleted_at is null
    limit 1)`;
}

function attributeNameSql(attributeDefIdCol: any) {
  return sql`(select ad.name from attribute_defs ad where ad.id = ${attributeDefIdCol} and ad.deleted_at is null limit 1)`;
}

const TABLES: TableSpec[] = [
  {
    name: 'entity_types',
    label: 'Типы сущностей',
    permission: [PermissionCode.MasterDataView, PermissionCode.EnginesView, PermissionCode.PartsView, PermissionCode.EmployeesView, PermissionCode.SupplyRequestsView],
    table: entityTypes,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: entityTypes.id },
      { id: 'code', label: 'Код', type: 'string', col: entityTypes.code },
      { id: 'name', label: 'Название', type: 'string', col: entityTypes.name },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: entityTypes.createdAt },
      { id: 'updatedAt', label: 'Обновлено', type: 'datetime', col: entityTypes.updatedAt },
      { id: 'deletedAt', label: 'Удалено', type: 'datetime', col: entityTypes.deletedAt },
      { id: 'syncStatus', label: 'Синхронизация', type: 'string', col: entityTypes.syncStatus },
    ],
  },
  {
    name: 'entities',
    label: 'Сущности',
    permission: [PermissionCode.MasterDataView, PermissionCode.EnginesView, PermissionCode.PartsView, PermissionCode.EmployeesView, PermissionCode.SupplyRequestsView],
    table: entities,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: entities.id },
      { id: 'typeId', label: 'Тип (ID)', type: 'string', col: entities.typeId },
      { id: 'entityTypeName', label: 'Тип', type: 'string', col: entityTypeNameSql(entities.typeId) },
      { id: 'displayName', label: 'Название', type: 'string', col: entityDisplayNameSql(entities.id) },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: entities.createdAt },
      { id: 'updatedAt', label: 'Обновлено', type: 'datetime', col: entities.updatedAt },
      { id: 'deletedAt', label: 'Удалено', type: 'datetime', col: entities.deletedAt },
      { id: 'syncStatus', label: 'Синхронизация', type: 'string', col: entities.syncStatus },
    ],
  },
  {
    name: 'attribute_defs',
    label: 'Атрибуты (определения)',
    permission: [PermissionCode.MasterDataView, PermissionCode.EnginesView, PermissionCode.PartsView, PermissionCode.EmployeesView, PermissionCode.SupplyRequestsView],
    table: attributeDefs,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: attributeDefs.id },
      { id: 'entityTypeId', label: 'Тип (ID)', type: 'string', col: attributeDefs.entityTypeId },
      { id: 'entityTypeName', label: 'Тип', type: 'string', col: entityTypeNameSql(attributeDefs.entityTypeId) },
      { id: 'code', label: 'Код', type: 'string', col: attributeDefs.code },
      { id: 'name', label: 'Название', type: 'string', col: attributeDefs.name },
      { id: 'dataType', label: 'Тип', type: 'string', col: attributeDefs.dataType },
      { id: 'isRequired', label: 'Обязательное', type: 'boolean', col: attributeDefs.isRequired },
      { id: 'sortOrder', label: 'Порядок', type: 'number', col: attributeDefs.sortOrder },
      { id: 'metaJson', label: 'Метаданные', type: 'json', col: attributeDefs.metaJson },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: attributeDefs.createdAt },
      { id: 'updatedAt', label: 'Обновлено', type: 'datetime', col: attributeDefs.updatedAt },
      { id: 'deletedAt', label: 'Удалено', type: 'datetime', col: attributeDefs.deletedAt },
      { id: 'syncStatus', label: 'Синхронизация', type: 'string', col: attributeDefs.syncStatus },
    ],
  },
  {
    name: 'attribute_values',
    label: 'Атрибуты (значения)',
    permission: [PermissionCode.MasterDataView, PermissionCode.EnginesView, PermissionCode.PartsView, PermissionCode.EmployeesView, PermissionCode.SupplyRequestsView],
    table: attributeValues,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: attributeValues.id },
      { id: 'entityId', label: 'Сущность (ID)', type: 'string', col: attributeValues.entityId },
      { id: 'entityTypeName', label: 'Тип сущности', type: 'string', col: entityTypeNameByEntityIdSql(attributeValues.entityId) },
      { id: 'entityName', label: 'Сущность', type: 'string', col: entityDisplayNameSql(attributeValues.entityId) },
      { id: 'attributeDefId', label: 'Свойство (ID)', type: 'string', col: attributeValues.attributeDefId },
      { id: 'attributeName', label: 'Свойство', type: 'string', col: attributeNameSql(attributeValues.attributeDefId) },
      { id: 'valueJson', label: 'Значение', type: 'json', col: attributeValues.valueJson },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: attributeValues.createdAt },
      { id: 'updatedAt', label: 'Обновлено', type: 'datetime', col: attributeValues.updatedAt },
      { id: 'deletedAt', label: 'Удалено', type: 'datetime', col: attributeValues.deletedAt },
      { id: 'syncStatus', label: 'Синхронизация', type: 'string', col: attributeValues.syncStatus },
    ],
  },
  {
    name: 'operations',
    label: 'Операции',
    permission: [PermissionCode.OperationsView],
    table: operations,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: operations.id },
      { id: 'engineEntityId', label: 'Двигатель', type: 'string', col: operations.engineEntityId },
      { id: 'operationType', label: 'Тип', type: 'string', col: operations.operationType },
      { id: 'status', label: 'Статус', type: 'string', col: operations.status },
      { id: 'note', label: 'Примечание', type: 'string', col: operations.note },
      { id: 'performedAt', label: 'Дата выполнения', type: 'datetime', col: operations.performedAt },
      { id: 'performedBy', label: 'Исполнитель', type: 'string', col: operations.performedBy },
      { id: 'metaJson', label: 'Метаданные', type: 'json', col: operations.metaJson },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: operations.createdAt },
      { id: 'updatedAt', label: 'Обновлено', type: 'datetime', col: operations.updatedAt },
      { id: 'deletedAt', label: 'Удалено', type: 'datetime', col: operations.deletedAt },
      { id: 'syncStatus', label: 'Синхронизация', type: 'string', col: operations.syncStatus },
    ],
  },
  {
    name: 'audit_log',
    label: 'Журнал',
    permission: [PermissionCode.AdminUsersManage],
    table: auditLog,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: auditLog.id },
      { id: 'actor', label: 'Автор', type: 'string', col: auditLog.actor },
      { id: 'action', label: 'Действие', type: 'string', col: auditLog.action },
      { id: 'entityId', label: 'Сущность', type: 'string', col: auditLog.entityId },
      { id: 'tableName', label: 'Таблица', type: 'string', col: auditLog.tableName },
      { id: 'payloadJson', label: 'Данные', type: 'json', col: auditLog.payloadJson },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: auditLog.createdAt },
      { id: 'updatedAt', label: 'Обновлено', type: 'datetime', col: auditLog.updatedAt },
      { id: 'deletedAt', label: 'Удалено', type: 'datetime', col: auditLog.deletedAt },
      { id: 'syncStatus', label: 'Синхронизация', type: 'string', col: auditLog.syncStatus },
    ],
  },
  {
    name: 'change_requests',
    label: 'Запросы на изменения',
    permission: [PermissionCode.AdminUsersManage],
    table: changeRequests,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: changeRequests.id },
      { id: 'status', label: 'Статус', type: 'string', col: changeRequests.status },
      { id: 'tableName', label: 'Таблица', type: 'string', col: changeRequests.tableName },
      { id: 'rowId', label: 'Строка', type: 'string', col: changeRequests.rowId },
      { id: 'rootEntityId', label: 'Корневая сущность', type: 'string', col: changeRequests.rootEntityId },
      { id: 'beforeJson', label: 'До', type: 'json', col: changeRequests.beforeJson },
      { id: 'afterJson', label: 'После', type: 'json', col: changeRequests.afterJson },
      { id: 'recordOwnerUserId', label: 'ID владельца', type: 'string', col: changeRequests.recordOwnerUserId },
      { id: 'recordOwnerUsername', label: 'Владелец', type: 'string', col: changeRequests.recordOwnerUsername },
      { id: 'changeAuthorUserId', label: 'ID автора', type: 'string', col: changeRequests.changeAuthorUserId },
      { id: 'changeAuthorUsername', label: 'Автор', type: 'string', col: changeRequests.changeAuthorUsername },
      { id: 'note', label: 'Примечание', type: 'string', col: changeRequests.note },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: changeRequests.createdAt },
      { id: 'decidedAt', label: 'Решено', type: 'datetime', col: changeRequests.decidedAt },
      { id: 'decidedByUserId', label: 'ID утвердившего', type: 'string', col: changeRequests.decidedByUserId },
      { id: 'decidedByUsername', label: 'Утвердивший', type: 'string', col: changeRequests.decidedByUsername },
    ],
  },
  {
    name: 'ledger_tx_index',
    label: 'Индекс транзакций',
    permission: [PermissionCode.AdminUsersManage],
    table: ledgerTxIndex,
    columns: [
      { id: 'serverSeq', label: 'Порядковый номер', type: 'number', col: ledgerTxIndex.serverSeq },
      { id: 'tableName', label: 'Таблица', type: 'string', col: ledgerTxIndex.tableName },
      { id: 'rowId', label: 'Строка', type: 'string', col: ledgerTxIndex.rowId },
      { id: 'op', label: 'Операция', type: 'string', col: ledgerTxIndex.op },
      { id: 'payloadJson', label: 'Данные', type: 'json', col: ledgerTxIndex.payloadJson },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: ledgerTxIndex.createdAt },
    ],
  },
  {
    name: 'row_owners',
    label: 'Владельцы записей',
    permission: [PermissionCode.AdminUsersManage],
    table: rowOwners,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: rowOwners.id },
      { id: 'tableName', label: 'Таблица', type: 'string', col: rowOwners.tableName },
      { id: 'rowId', label: 'Строка', type: 'string', col: rowOwners.rowId },
      { id: 'ownerUserId', label: 'ID владельца', type: 'string', col: rowOwners.ownerUserId },
      { id: 'ownerUsername', label: 'Владелец', type: 'string', col: rowOwners.ownerUsername },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: rowOwners.createdAt },
    ],
  },
  {
    name: 'sync_state',
    label: 'Состояние синхронизации',
    permission: [PermissionCode.AdminUsersManage],
    table: syncState,
    columns: [
      { id: 'clientId', label: 'Клиент', type: 'string', col: syncState.clientId },
      { id: 'lastPulledServerSeq', label: 'Последний применённый порядковый номер', type: 'number', col: syncState.lastPulledServerSeq },
      { id: 'lastPushedAt', label: 'Последняя отправка', type: 'datetime', col: syncState.lastPushedAt },
      { id: 'lastPulledAt', label: 'Последнее получение', type: 'datetime', col: syncState.lastPulledAt },
    ],
  },
  {
    name: 'users',
    label: 'Пользователи',
    permission: [PermissionCode.AdminUsersManage],
    table: users,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: users.id },
      { id: 'username', label: 'Логин', type: 'string', col: users.username },
      { id: 'passwordHash', label: 'Пароль (хэш)', type: 'string', col: users.passwordHash },
      { id: 'role', label: 'Роль', type: 'string', col: users.role },
      { id: 'isActive', label: 'Активен', type: 'boolean', col: users.isActive },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: users.createdAt },
      { id: 'updatedAt', label: 'Обновлено', type: 'datetime', col: users.updatedAt },
      { id: 'deletedAt', label: 'Удалено', type: 'datetime', col: users.deletedAt },
    ],
  },
  {
    name: 'refresh_tokens',
    label: 'Токены обновления',
    permission: [PermissionCode.AdminUsersManage],
    table: refreshTokens,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: refreshTokens.id },
      { id: 'userId', label: 'Пользователь', type: 'string', col: refreshTokens.userId },
      { id: 'tokenHash', label: 'Хэш токена', type: 'string', col: refreshTokens.tokenHash },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: refreshTokens.createdAt },
      { id: 'expiresAt', label: 'Истекает', type: 'datetime', col: refreshTokens.expiresAt },
    ],
  },
  {
    name: 'permissions',
    label: 'Разрешения',
    permission: [PermissionCode.AdminUsersManage],
    table: permissions,
    columns: [
      { id: 'code', label: 'Код', type: 'string', col: permissions.code },
      { id: 'description', label: 'Описание', type: 'string', col: permissions.description },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: permissions.createdAt },
    ],
  },
  {
    name: 'user_permissions',
    label: 'Разрешения пользователя',
    permission: [PermissionCode.AdminUsersManage],
    table: userPermissions,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: userPermissions.id },
      { id: 'userId', label: 'Пользователь', type: 'string', col: userPermissions.userId },
      { id: 'permCode', label: 'Код разрешения', type: 'string', col: userPermissions.permCode },
      { id: 'allowed', label: 'Разрешено', type: 'boolean', col: userPermissions.allowed },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: userPermissions.createdAt },
    ],
  },
  {
    name: 'permission_delegations',
    label: 'Передача разрешений',
    permission: [PermissionCode.AdminUsersManage],
    table: permissionDelegations,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: permissionDelegations.id },
      { id: 'fromUserId', label: 'От кого', type: 'string', col: permissionDelegations.fromUserId },
      { id: 'toUserId', label: 'Кому', type: 'string', col: permissionDelegations.toUserId },
      { id: 'permCode', label: 'Разрешение', type: 'string', col: permissionDelegations.permCode },
      { id: 'startsAt', label: 'Начало', type: 'datetime', col: permissionDelegations.startsAt },
      { id: 'endsAt', label: 'Конец', type: 'datetime', col: permissionDelegations.endsAt },
      { id: 'note', label: 'Примечание', type: 'string', col: permissionDelegations.note },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: permissionDelegations.createdAt },
      { id: 'createdByUserId', label: 'Кто создал', type: 'string', col: permissionDelegations.createdByUserId },
      { id: 'revokedAt', label: 'Отозвано', type: 'datetime', col: permissionDelegations.revokedAt },
      { id: 'revokedByUserId', label: 'Кто отозвал', type: 'string', col: permissionDelegations.revokedByUserId },
      { id: 'revokeNote', label: 'Причина', type: 'string', col: permissionDelegations.revokeNote },
    ],
  },
  {
    name: 'file_assets',
    label: 'Файлы',
    permission: [PermissionCode.FilesView],
    table: fileAssets,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: fileAssets.id },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: fileAssets.createdAt },
      { id: 'createdByUserId', label: 'Создал', type: 'string', col: fileAssets.createdByUserId },
      { id: 'name', label: 'Название', type: 'string', col: fileAssets.name },
      { id: 'size', label: 'Размер', type: 'number', col: fileAssets.size },
      { id: 'mime', label: 'Тип содержимого', type: 'string', col: fileAssets.mime },
      { id: 'sha256', label: 'Хэш SHA-256', type: 'string', col: fileAssets.sha256 },
      { id: 'storageKind', label: 'Хранилище', type: 'string', col: fileAssets.storageKind },
      { id: 'localRelPath', label: 'Локальный путь', type: 'string', col: fileAssets.localRelPath },
      { id: 'yandexDiskPath', label: 'Путь Яндекс Диска', type: 'string', col: fileAssets.yandexDiskPath },
      { id: 'previewMime', label: 'Тип превью', type: 'string', col: fileAssets.previewMime },
      { id: 'previewSize', label: 'Размер превью', type: 'number', col: fileAssets.previewSize },
      { id: 'previewLocalRelPath', label: 'Путь превью', type: 'string', col: fileAssets.previewLocalRelPath },
      { id: 'deletedAt', label: 'Удалено', type: 'datetime', col: fileAssets.deletedAt },
    ],
  },
  {
    name: 'client_settings',
    label: 'Настройки клиентов',
    permission: [PermissionCode.ClientsManage],
    table: clientSettings,
    columns: [
      { id: 'clientId', label: 'Клиент', type: 'string', col: clientSettings.clientId },
      { id: 'updatesEnabled', label: 'Обновления', type: 'boolean', col: clientSettings.updatesEnabled },
      { id: 'torrentEnabled', label: 'Обновления через торрент', type: 'boolean', col: clientSettings.torrentEnabled },
      { id: 'loggingEnabled', label: 'Логирование', type: 'boolean', col: clientSettings.loggingEnabled },
      { id: 'loggingMode', label: 'Режим логирования', type: 'string', col: clientSettings.loggingMode },
      { id: 'uiDisplayPrefs', label: 'Настройки интерфейса', type: 'string', col: clientSettings.uiDisplayPrefs },
      { id: 'lastSeenAt', label: 'Последняя активность', type: 'datetime', col: clientSettings.lastSeenAt },
      { id: 'lastVersion', label: 'Версия ПО', type: 'string', col: clientSettings.lastVersion },
      { id: 'lastIp', label: 'Последний IP', type: 'string', col: clientSettings.lastIp },
      { id: 'lastHostname', label: 'Имя хоста', type: 'string', col: clientSettings.lastHostname },
      { id: 'lastPlatform', label: 'Платформа', type: 'string', col: clientSettings.lastPlatform },
      { id: 'lastArch', label: 'Архитектура', type: 'string', col: clientSettings.lastArch },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: clientSettings.createdAt },
      { id: 'updatedAt', label: 'Обновлено', type: 'datetime', col: clientSettings.updatedAt },
    ],
  },
  {
    name: 'diagnostics_snapshots',
    label: 'Диагностика',
    permission: [PermissionCode.ClientsManage],
    table: diagnosticsSnapshots,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: diagnosticsSnapshots.id },
      { id: 'clientId', label: 'Клиент', type: 'string', col: diagnosticsSnapshots.clientId },
      { id: 'payloadJson', label: 'Данные', type: 'json', col: diagnosticsSnapshots.payloadJson },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: diagnosticsSnapshots.createdAt },
    ],
  },
  {
    name: 'chat_messages',
    label: 'Чат: сообщения',
    permission: [PermissionCode.ChatUse],
    table: chatMessages,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: chatMessages.id },
      { id: 'senderUserId', label: 'Отправитель', type: 'string', col: chatMessages.senderUserId },
      { id: 'senderUsername', label: 'Имя отправителя', type: 'string', col: chatMessages.senderUsername },
      { id: 'recipientUserId', label: 'Получатель', type: 'string', col: chatMessages.recipientUserId },
      { id: 'messageType', label: 'Тип', type: 'string', col: chatMessages.messageType },
      { id: 'bodyText', label: 'Текст', type: 'string', col: chatMessages.bodyText },
      { id: 'payloadJson', label: 'Данные', type: 'json', col: chatMessages.payloadJson },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: chatMessages.createdAt },
      { id: 'updatedAt', label: 'Обновлено', type: 'datetime', col: chatMessages.updatedAt },
      { id: 'deletedAt', label: 'Удалено', type: 'datetime', col: chatMessages.deletedAt },
      { id: 'syncStatus', label: 'Синхронизация', type: 'string', col: chatMessages.syncStatus },
    ],
  },
  {
    name: 'chat_reads',
    label: 'Чат: прочтения',
    permission: [PermissionCode.ChatUse],
    table: chatReads,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: chatReads.id },
      { id: 'messageId', label: 'Сообщение', type: 'string', col: chatReads.messageId },
      { id: 'userId', label: 'Пользователь', type: 'string', col: chatReads.userId },
      { id: 'readAt', label: 'Прочитано', type: 'datetime', col: chatReads.readAt },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: chatReads.createdAt },
      { id: 'updatedAt', label: 'Обновлено', type: 'datetime', col: chatReads.updatedAt },
      { id: 'deletedAt', label: 'Удалено', type: 'datetime', col: chatReads.deletedAt },
      { id: 'syncStatus', label: 'Синхронизация', type: 'string', col: chatReads.syncStatus },
    ],
  },
  {
    name: 'notes',
    label: 'Заметки',
    permission: [PermissionCode.ReportsView],
    table: notes,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: notes.id },
      { id: 'ownerUserId', label: 'Владелец', type: 'string', col: notes.ownerUserId },
      { id: 'title', label: 'Заголовок', type: 'string', col: notes.title },
      { id: 'bodyJson', label: 'Содержимое', type: 'json', col: notes.bodyJson },
      { id: 'importance', label: 'Важность', type: 'string', col: notes.importance },
      { id: 'dueAt', label: 'Срок', type: 'datetime', col: notes.dueAt },
      { id: 'sortOrder', label: 'Порядок', type: 'number', col: notes.sortOrder },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: notes.createdAt },
      { id: 'updatedAt', label: 'Обновлено', type: 'datetime', col: notes.updatedAt },
      { id: 'deletedAt', label: 'Удалено', type: 'datetime', col: notes.deletedAt },
      { id: 'syncStatus', label: 'Синхронизация', type: 'string', col: notes.syncStatus },
    ],
  },
  {
    name: 'note_shares',
    label: 'Заметки: доступы',
    permission: [PermissionCode.ReportsView],
    table: noteShares,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: noteShares.id },
      { id: 'noteId', label: 'Заметка', type: 'string', col: noteShares.noteId },
      { id: 'recipientUserId', label: 'Получатель', type: 'string', col: noteShares.recipientUserId },
      { id: 'hidden', label: 'Скрыта', type: 'boolean', col: noteShares.hidden },
      { id: 'sortOrder', label: 'Порядок', type: 'number', col: noteShares.sortOrder },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: noteShares.createdAt },
      { id: 'updatedAt', label: 'Обновлено', type: 'datetime', col: noteShares.updatedAt },
      { id: 'deletedAt', label: 'Удалено', type: 'datetime', col: noteShares.deletedAt },
      { id: 'syncStatus', label: 'Синхронизация', type: 'string', col: noteShares.syncStatus },
    ],
  },
  {
    name: 'user_presence',
    label: 'Присутствие',
    permission: [PermissionCode.ChatUse],
    table: userPresence,
    columns: [
      { id: 'id', label: 'ID', type: 'string', col: userPresence.id },
      { id: 'userId', label: 'Пользователь', type: 'string', col: userPresence.userId },
      { id: 'lastActivityAt', label: 'Активность', type: 'datetime', col: userPresence.lastActivityAt },
      { id: 'createdAt', label: 'Создано', type: 'datetime', col: userPresence.createdAt },
      { id: 'updatedAt', label: 'Обновлено', type: 'datetime', col: userPresence.updatedAt },
      { id: 'deletedAt', label: 'Удалено', type: 'datetime', col: userPresence.deletedAt },
      { id: 'syncStatus', label: 'Синхронизация', type: 'string', col: userPresence.syncStatus },
    ],
  },
];

const filterConditionSchema = z.object({
  kind: z.literal('condition'),
  column: z.string(),
  operator: z.enum([
    'eq',
    'neq',
    'contains',
    'starts_with',
    'ends_with',
    'gt',
    'gte',
    'lt',
    'lte',
    'between',
    'in',
    'is_null',
    'not_null',
  ] as [ReportBuilderOperator, ...ReportBuilderOperator[]]),
  value: z.any().optional(),
});

let filterSchema: z.ZodType<ReportBuilderFilter>;
const filterGroupSchema: z.ZodType<ReportBuilderFilterGroup> = z.lazy(() =>
  z.object({
    kind: z.literal('group'),
    op: z.enum(['and', 'or']),
    items: z.array(filterSchema),
  }),
);
filterSchema = z.lazy(() => z.union([filterConditionSchema, filterGroupSchema]));

const tableRequestSchema = z.object({
  name: z.string(),
  filters: filterGroupSchema.optional().nullable(),
});

const previewSchema = z.object({
  tables: z.array(tableRequestSchema).min(1),
  limit: z.number().int().min(1).max(500).optional(),
});

const exportSchema = previewSchema.extend({
  format: z.enum(['html', 'xlsx']),
});

function findTable(name: string): TableSpec | undefined {
  return TABLES.find((t) => t.name === name);
}

function allowedForTable(perms: Record<string, boolean>, table: TableSpec): boolean {
  if (table.permission.length === 0) return true;
  return table.permission.some((p) => perms[p] === true);
}

function normalizeValue(type: ColumnSpec['type'], value: any): any {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((v) => normalizeValue(type, v));
  if (type === 'number' || type === 'datetime') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return Boolean(value);
  }
  return String(value);
}

function parseList(value: any, type: ColumnSpec['type']): any[] {
  if (Array.isArray(value)) return normalizeValue(type, value);
  if (typeof value === 'string') {
    const parts = value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    return normalizeValue(type, parts);
  }
  return normalizeValue(type, [value]);
}

function buildCondition(table: TableSpec, cond: ReportBuilderFilterCondition): any | null {
  const col = table.columns.find((c) => c.id === cond.column);
  if (!col) return null;
  const colExpr = col.col;
  const op = cond.operator;
  const val = normalizeValue(col.type, cond.value);
  if (op === 'is_null') return isNull(colExpr);
  if (op === 'not_null') return isNotNull(colExpr);
  if (op === 'eq') return eq(colExpr, val as any);
  if (op === 'neq') return ne(colExpr, val as any);
  if (op === 'gt') return gt(colExpr, val as any);
  if (op === 'gte') return gte(colExpr, val as any);
  if (op === 'lt') return lt(colExpr, val as any);
  if (op === 'lte') return lte(colExpr, val as any);
  if (op === 'between') {
    const list = parseList(cond.value, col.type);
    if (list.length < 2) return null;
    return and(gte(colExpr, list[0] as any), lte(colExpr, list[1] as any));
  }
  if (op === 'in') {
    const list = parseList(cond.value, col.type);
    if (list.length === 0) return null;
    return inArray(colExpr, list as any[]);
  }
  if (op === 'contains') return ilike(sql`${colExpr}::text`, `%${String(val ?? '')}%`);
  if (op === 'starts_with') return ilike(sql`${colExpr}::text`, `${String(val ?? '')}%`);
  if (op === 'ends_with') return ilike(sql`${colExpr}::text`, `%${String(val ?? '')}`);
  return null;
}

function buildGroup(table: TableSpec, group?: ReportBuilderFilterGroup | null): any | null {
  if (!group || group.items.length === 0) return null;
  const built = group.items
    .map((item) => {
      if (item.kind === 'group') return buildGroup(table, item);
      return buildCondition(table, item);
    })
    .filter(Boolean);
  if (built.length === 0) return null;
  if (built.length === 1) return built[0];
  return group.op === 'or' ? or(...built) : and(...built);
}

function htmlEscape(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(tables: ReportBuilderPreviewTable[]): string {
  const sections = tables
    .map((t) => {
      const header = t.columns.map((c) => `<th>${htmlEscape(c.label)}</th>`).join('');
      const rows = t.rows
        .map((r) => {
          const cells = t.columns
            .map((c) => {
              const raw = r[c.id];
              const v = raw == null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw);
              return `<td>${htmlEscape(String(v))}</td>`;
            })
            .join('');
          return `<tr>${cells}</tr>`;
        })
        .join('');
      return `<h3>${htmlEscape(t.label)}</h3><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"/><style>body{font-family:Arial,sans-serif;font-size:12px}table{border-collapse:collapse;width:100%;margin-bottom:24px}th,td{border:1px solid #ddd;padding:6px;text-align:left}th{background:#f3f4f6}</style></head><body>${sections}</body></html>`;
}

reportsRouter.get('/builder/meta', async (_req, res) => {
  try {
    return res.json({
      ok: true,
      tables: TABLES.map((t) => ({
        name: t.name,
        label: t.label,
        columns: visibleColumns(t).map(({ id, label, type }) => ({ id, label, type })),
      })).filter((t) => t.columns.length > 0),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

reportsRouter.post('/builder/preview', async (req, res) => {
  try {
    const parsed = previewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const actor = (req as AuthenticatedRequest).user;
    const perms = actor?.id ? await getEffectivePermissionsForUser(String(actor.id)) : {};
    const limit = parsed.data.limit ?? 50;

    let warning: string | null = null;
    const tables: ReportBuilderPreviewTable[] = [];

    for (const t of parsed.data.tables) {
      const meta = findTable(t.name);
      if (!meta) continue;
      if (!allowedForTable(perms, meta)) {
        warning = 'Доступ к некоторым данным запрещен для вашего аккаунта. Вывод данных в отчете будет неполным';
        continue;
      }
      const cols = visibleColumns(meta);
      if (!cols.length) continue;
      const selectMap: Record<string, any> = {};
      for (const c of cols) selectMap[c.id] = c.col;
      const where = buildGroup(meta, t.filters ?? null);
      const query = db.select(selectMap).from(meta.table);
      const rows = await (where ? query.where(where) : query).limit(limit);
      tables.push({
        name: meta.name,
        label: meta.label,
        columns: cols.map(({ id, label, type }) => ({ id, label, type })),
        rows: rows as any[],
      });
    }
    if (tables.length === 0) return res.json({ ok: false, error: 'Нет доступных таблиц для выгрузки' });
    return res.json({ ok: true, warning, tables });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

reportsRouter.post('/builder/export', async (req, res) => {
  try {
    const parsed = exportSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const actor = (req as AuthenticatedRequest).user;
    const perms = actor?.id ? await getEffectivePermissionsForUser(String(actor.id)) : {};
    const limit = parsed.data.limit ?? 50_000;
    let warning: string | null = null;

    const tables: ReportBuilderPreviewTable[] = [];
    for (const t of parsed.data.tables) {
      const meta = findTable(t.name);
      if (!meta) continue;
      if (!allowedForTable(perms, meta)) {
        warning = 'Доступ к некоторым данным запрещен для вашего аккаунта. Вывод данных в отчете будет неполным';
        continue;
      }
      const cols = visibleColumns(meta);
      if (!cols.length) continue;
      const selectMap: Record<string, any> = {};
      for (const c of cols) selectMap[c.id] = c.col;
      const where = buildGroup(meta, t.filters ?? null);
      const query = db.select(selectMap).from(meta.table);
      const rows = await (where ? query.where(where) : query).limit(limit);
      tables.push({
        name: meta.name,
        label: meta.label,
        columns: cols.map(({ id, label, type }) => ({ id, label, type })),
        rows: rows as any[],
      });
    }
    if (tables.length === 0) return res.json({ ok: false, error: 'Нет доступных таблиц для выгрузки' });

    if (parsed.data.format === 'html') {
      const html = renderHtml(tables);
      const contentBase64 = Buffer.from(html, 'utf8').toString('base64');
      const fileName = `report_${new Date().toISOString().slice(0, 10)}.html`;
      return res.json({ ok: true, warning, fileName, mime: 'text/html', contentBase64 });
    }

    const workbook = new ExcelJS.Workbook();
    for (const t of tables) {
      const sheet = workbook.addWorksheet(t.label.slice(0, 31));
      sheet.addRow(t.columns.map((c) => c.label));
      for (const row of t.rows) {
        sheet.addRow(
          t.columns.map((c) => {
            const raw = (row as any)[c.id];
            if (raw == null) return '';
            if (typeof raw === 'string') return raw;
            return JSON.stringify(raw);
          }),
        );
      }
    }
    const buf = await workbook.xlsx.writeBuffer();
    const contentBase64 = Buffer.from(buf).toString('base64');
    const fileName = `report_${new Date().toISOString().slice(0, 10)}.xlsx`;
    return res.json({
      ok: true,
      warning,
      fileName,
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBase64,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
