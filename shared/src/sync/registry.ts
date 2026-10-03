/**
 * SyncTableRegistry -- единый источник правды для всех таблиц синхронизации.
 *
 * Централизует:
 *  - Zod-схему каждой таблицы
 *  - Маппинг camelCase (drizzle) <-> snake_case (DTO/ledger)
 *  - Conflict-target поля для UPSERT
 *  - Граф зависимостей (порядок обработки)
 *  - Маппинг SyncTableName <-> LedgerTableName
 *
 * Используется на сервере и клиенте вместо дублированных TABLE_MAP / SYNC_TABLES / toSyncRow.
 */
import type { z } from 'zod';

import { SyncTableName } from './tables.js';
import {
  entityTypeRowSchema,
  entityRowSchema,
  attributeDefRowSchema,
  attributeValueRowSchema,
  operationRowSchema,
  auditLogRowSchema,
  chatMessageRowSchema,
  chatReadRowSchema,
  chatRoomRowSchema,
  userPresenceRowSchema,
  noteRowSchema,
  noteShareRowSchema,
  cardDraftRowSchema,
  aiChatRequestRowSchema,
  userRowSchema,
  userSectionAccessRowSchema,
  warehouseLocationRowSchema,
  erpCounterpartyRowSchema,
  erpContractRowSchema,
  erpContractPaymentSlotRowSchema,
  erpContractPaymentRowSchema,
  erpEngineCardRowSchema,
  directoryEngineBrandRowSchema,
} from './dto.js';
import {
  erpEngineInstanceRowSchema,
  erpEngineAssemblyBomLineRowSchema,
  erpEngineAssemblyBomRowSchema,
  erpEngineAssemblyBomBrandLinkRowSchema,
  erpNomenclatureRowSchema,
  erpRegisterStockBalanceRowSchema,
  erpRegisterStockMovementRowSchema,
  erpEngineInventoryLineRowSchema,
} from './erpDto.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** A single field mapping: DB column name (camelCase) <-> DTO field name (snake_case). */
export type FieldMapping = {
  db: string;
  dto: string;
};

/** Full registry entry for one sync table. */
export type SyncTableEntry = {
  /** Canonical sync table name (snake_case string). */
  syncName: SyncTableName;
  /** Matching ledger table name (same string value for sync tables). */
  ledgerName: string;
  /** Zod schema for validation. */
  schema: z.ZodTypeAny;
  /** Ordered list of field mappings. */
  fields: readonly FieldMapping[];
  /** DB column names used for ON CONFLICT (conflict target). */
  conflictTarget: readonly string[];
  /** Tables this table depends on (must be processed first). */
  dependsOn: readonly SyncTableName[];
};

// ────────────────────────────────────────────────────────────
// Field mapping definitions
// ────────────────────────────────────────────────────────────

const BASE_FIELDS: readonly FieldMapping[] = [
  { db: 'id', dto: 'id' },
  { db: 'createdAt', dto: 'created_at' },
  { db: 'updatedAt', dto: 'updated_at' },
  { db: 'lastServerSeq', dto: 'last_server_seq' },
  { db: 'deletedAt', dto: 'deleted_at' },
  { db: 'syncStatus', dto: 'sync_status' },
] as const;

function withBase(...extra: FieldMapping[]): readonly FieldMapping[] {
  return [...BASE_FIELDS, ...extra] as const;
}

const ENTITY_TYPE_FIELDS = withBase(
  { db: 'code', dto: 'code' },
  { db: 'name', dto: 'name' },
);

const ENTITY_FIELDS = withBase(
  { db: 'typeId', dto: 'type_id' },
);

const ATTRIBUTE_DEF_FIELDS = withBase(
  { db: 'entityTypeId', dto: 'entity_type_id' },
  { db: 'code', dto: 'code' },
  { db: 'name', dto: 'name' },
  { db: 'dataType', dto: 'data_type' },
  { db: 'isRequired', dto: 'is_required' },
  { db: 'sortOrder', dto: 'sort_order' },
  { db: 'metaJson', dto: 'meta_json' },
);

const ATTRIBUTE_VALUE_FIELDS = withBase(
  { db: 'entityId', dto: 'entity_id' },
  { db: 'attributeDefId', dto: 'attribute_def_id' },
  { db: 'valueJson', dto: 'value_json' },
);

const OPERATION_FIELDS = withBase(
  { db: 'engineEntityId', dto: 'engine_entity_id' },
  { db: 'operationType', dto: 'operation_type' },
  { db: 'status', dto: 'status' },
  { db: 'note', dto: 'note' },
  { db: 'performedAt', dto: 'performed_at' },
  { db: 'performedBy', dto: 'performed_by' },
  { db: 'metaJson', dto: 'meta_json' },
);

const AUDIT_LOG_FIELDS = withBase(
  { db: 'actor', dto: 'actor' },
  { db: 'action', dto: 'action' },
  { db: 'entityId', dto: 'entity_id' },
  { db: 'tableName', dto: 'table_name' },
  { db: 'payloadJson', dto: 'payload_json' },
);

const CHAT_MESSAGE_FIELDS = withBase(
  { db: 'senderUserId', dto: 'sender_user_id' },
  { db: 'senderUsername', dto: 'sender_username' },
  { db: 'recipientUserId', dto: 'recipient_user_id' },
  { db: 'roomId', dto: 'room_id' },
  { db: 'messageType', dto: 'message_type' },
  { db: 'bodyText', dto: 'body_text' },
  { db: 'payloadJson', dto: 'payload_json' },
);

const CHAT_READ_FIELDS = withBase(
  { db: 'messageId', dto: 'message_id' },
  { db: 'userId', dto: 'user_id' },
  { db: 'readAt', dto: 'read_at' },
);

const CHAT_ROOM_FIELDS = withBase(
  { db: 'ownerUserId', dto: 'owner_user_id' },
  { db: 'title', dto: 'title' },
  { db: 'membersJson', dto: 'members_json' },
);

const USER_PRESENCE_FIELDS = withBase(
  { db: 'userId', dto: 'user_id' },
  { db: 'lastActivityAt', dto: 'last_activity_at' },
);

const NOTE_FIELDS = withBase(
  { db: 'ownerUserId', dto: 'owner_user_id' },
  { db: 'title', dto: 'title' },
  { db: 'bodyJson', dto: 'body_json' },
  { db: 'importance', dto: 'importance' },
  { db: 'dueAt', dto: 'due_at' },
  { db: 'sortOrder', dto: 'sort_order' },
);

const NOTE_SHARE_FIELDS = withBase(
  { db: 'noteId', dto: 'note_id' },
  { db: 'recipientUserId', dto: 'recipient_user_id' },
  { db: 'hidden', dto: 'hidden' },
  { db: 'sortOrder', dto: 'sort_order' },
);

const CARD_DRAFT_FIELDS = withBase(
  { db: 'ownerUserId', dto: 'owner_user_id' },
  { db: 'cardType', dto: 'card_type' },
  { db: 'cardId', dto: 'card_id' },
  { db: 'kind', dto: 'kind' },
  { db: 'title', dto: 'title' },
  { db: 'payloadJson', dto: 'payload_json' },
  { db: 'baseUpdatedAt', dto: 'base_updated_at' },
);

const AI_CHAT_REQUEST_FIELDS = withBase(
  { db: 'userId', dto: 'user_id' },
  { db: 'username', dto: 'username' },
  { db: 'questionText', dto: 'question_text' },
  { db: 'questionFileJson', dto: 'question_file_json' },
  { db: 'status', dto: 'status' },
  { db: 'answerText', dto: 'answer_text' },
  { db: 'answerFilesJson', dto: 'answer_files_json' },
  { db: 'answeredAt', dto: 'answered_at' },
  { db: 'escalationNote', dto: 'escalation_note' },
  { db: 'verdictText', dto: 'verdict_text' },
);

const ERP_NOMENCLATURE_FIELDS: readonly FieldMapping[] = [
  { db: 'id', dto: 'id' },
  { db: 'code', dto: 'code' },
  { db: 'sku', dto: 'sku' },
  { db: 'name', dto: 'name' },
  { db: 'itemType', dto: 'item_type' },
  { db: 'category', dto: 'category' },
  { db: 'directoryKind', dto: 'directory_kind' },
  { db: 'directoryRefId', dto: 'directory_ref_id' },
  { db: 'groupId', dto: 'group_id' },
  { db: 'unitId', dto: 'unit_id' },
  { db: 'barcode', dto: 'barcode' },
  { db: 'minStock', dto: 'min_stock' },
  { db: 'maxStock', dto: 'max_stock' },
  { db: 'defaultBrandId', dto: 'default_brand_id' },
  { db: 'isSerialTracked', dto: 'is_serial_tracked' },
  { db: 'defaultWarehouseId', dto: 'default_warehouse_id' },
  { db: 'specJson', dto: 'spec_json' },
  { db: 'isActive', dto: 'is_active' },
  { db: 'syncStatus', dto: 'sync_status' },
  { db: 'lastServerSeq', dto: 'last_server_seq' },
  { db: 'createdAt', dto: 'created_at' },
  { db: 'updatedAt', dto: 'updated_at' },
  { db: 'deletedAt', dto: 'deleted_at' },
] as const;

const ERP_ENGINE_INSTANCE_FIELDS: readonly FieldMapping[] = [
  { db: 'id', dto: 'id' },
  { db: 'nomenclatureId', dto: 'nomenclature_id' },
  { db: 'serialNumber', dto: 'serial_number' },
  { db: 'contractId', dto: 'contract_id' },
  { db: 'currentStatus', dto: 'current_status' },
  { db: 'warehouseLocationId', dto: 'warehouse_location_id' },
  { db: 'createdAt', dto: 'created_at' },
  { db: 'updatedAt', dto: 'updated_at' },
  { db: 'deletedAt', dto: 'deleted_at' },
  { db: 'syncStatus', dto: 'sync_status' },
  { db: 'lastServerSeq', dto: 'last_server_seq' },
] as const;

const ERP_ENGINE_ASSEMBLY_BOM_FIELDS: readonly FieldMapping[] = [
  { db: 'id', dto: 'id' },
  { db: 'name', dto: 'name' },
  { db: 'engineNomenclatureId', dto: 'engine_nomenclature_id' },
  { db: 'version', dto: 'version' },
  { db: 'status', dto: 'status' },
  { db: 'isDefault', dto: 'is_default' },
  { db: 'defaultVariantKey', dto: 'default_variant_key' },
  { db: 'executionProfileJson', dto: 'execution_profile_json' },
  { db: 'notes', dto: 'notes' },
  { db: 'createdAt', dto: 'created_at' },
  { db: 'updatedAt', dto: 'updated_at' },
  { db: 'deletedAt', dto: 'deleted_at' },
  { db: 'syncStatus', dto: 'sync_status' },
  { db: 'lastServerSeq', dto: 'last_server_seq' },
] as const;

const ERP_ENGINE_ASSEMBLY_BOM_BRAND_LINK_FIELDS: readonly FieldMapping[] = [
  { db: 'id', dto: 'id' },
  { db: 'bomId', dto: 'bom_id' },
  { db: 'engineBrandId', dto: 'engine_brand_id' },
  { db: 'isPrimary', dto: 'is_primary' },
  { db: 'isDefaultForBrand', dto: 'is_default_for_brand' },
  { db: 'createdAt', dto: 'created_at' },
  { db: 'updatedAt', dto: 'updated_at' },
  { db: 'deletedAt', dto: 'deleted_at' },
  { db: 'syncStatus', dto: 'sync_status' },
  { db: 'lastServerSeq', dto: 'last_server_seq' },
] as const;

const ERP_ENGINE_ASSEMBLY_BOM_LINE_FIELDS: readonly FieldMapping[] = [
  { db: 'id', dto: 'id' },
  { db: 'bomId', dto: 'bom_id' },
  { db: 'componentNomenclatureId', dto: 'component_nomenclature_id' },
  { db: 'componentType', dto: 'component_type' },
  { db: 'qtyPerUnit', dto: 'qty_per_unit' },
  { db: 'variantGroup', dto: 'variant_group' },
  { db: 'isRequired', dto: 'is_required' },
  { db: 'priority', dto: 'priority' },
  { db: 'notes', dto: 'notes' },
  { db: 'positionKey', dto: 'position_key' },
  { db: 'positionLabel', dto: 'position_label' },
  { db: 'isDefaultOption', dto: 'is_default_option' },
  { db: 'createdAt', dto: 'created_at' },
  { db: 'updatedAt', dto: 'updated_at' },
  { db: 'deletedAt', dto: 'deleted_at' },
  { db: 'syncStatus', dto: 'sync_status' },
  { db: 'lastServerSeq', dto: 'last_server_seq' },
] as const;

const ERP_STOCK_BALANCE_FIELDS: readonly FieldMapping[] = [
  { db: 'id', dto: 'id' },
  { db: 'nomenclatureId', dto: 'nomenclature_id' },
  { db: 'partCardId', dto: 'part_card_id' },
  { db: 'warehouseLocationId', dto: 'warehouse_location_id' },
  { db: 'qty', dto: 'qty' },
  { db: 'reservedQty', dto: 'reserved_qty' },
  { db: 'updatedAt', dto: 'updated_at' },
] as const;

const ERP_ENGINE_INVENTORY_LINE_FIELDS: readonly FieldMapping[] = withBase(
  { db: 'operationId', dto: 'operation_id' },
  { db: 'engineEntityId', dto: 'engine_entity_id' },
  { db: 'lineKey', dto: 'line_key' },
  { db: 'sortOrder', dto: 'sort_order' },
  { db: 'partId', dto: 'part_id' },
  { db: 'brandManaged', dto: 'brand_managed' },
  { db: 'partName', dto: 'part_name' },
  { db: 'assemblyUnitNumber', dto: 'assembly_unit_number' },
  { db: 'partNumber', dto: 'part_number' },
  { db: 'stampedNumber', dto: 'stamped_number' },
  { db: 'bomVariantGroup', dto: 'bom_variant_group' },
  { db: 'quantity', dto: 'quantity' },
  { db: 'present', dto: 'present' },
  { db: 'actualQty', dto: 'actual_qty' },
  { db: 'repairableQty', dto: 'repairable_qty' },
  { db: 'scrapQty', dto: 'scrap_qty' },
  { db: 'replaceQty', dto: 'replace_qty' },
  { db: 'replenishmentBranch', dto: 'replenishment_branch' },
  { db: 'scrapReason', dto: 'scrap_reason' },
  { db: 'inCompletenessAct', dto: 'in_completeness_act' },
  { db: 'inDefectAct', dto: 'in_defect_act' },
  { db: 'inCompletenessActOverride', dto: 'in_completeness_act_override' },
  { db: 'inDefectActOverride', dto: 'in_defect_act_override' },
  { db: 'hasOwnNumber', dto: 'has_own_number' },
  { db: 'hasOwnNumberOverride', dto: 'has_own_number_override' },
  { db: 'selected', dto: 'selected' },
  { db: 'photosJson', dto: 'photos_json' },
);

const ERP_STOCK_MOVEMENT_FIELDS: readonly FieldMapping[] = [
  { db: 'id', dto: 'id' },
  { db: 'nomenclatureId', dto: 'nomenclature_id' },
  { db: 'warehouseLocationId', dto: 'warehouse_location_id' },
  { db: 'documentHeaderId', dto: 'document_header_id' },
  { db: 'movementType', dto: 'movement_type' },
  { db: 'qty', dto: 'qty' },
  { db: 'direction', dto: 'direction' },
  { db: 'engineId', dto: 'engine_id' },
  { db: 'counterpartyId', dto: 'counterparty_id' },
  { db: 'reason', dto: 'reason' },
  { db: 'performedAt', dto: 'performed_at' },
  { db: 'performedBy', dto: 'performed_by' },
  { db: 'prevHash', dto: 'prev_hash' },
  { db: 'selfHash', dto: 'self_hash' },
  { db: 'createdAt', dto: 'created_at' },
] as const;

const WAREHOUSE_LOCATION_FIELDS = withBase(
  { db: 'type', dto: 'type' },
  { db: 'code', dto: 'code' },
  { db: 'name', dto: 'name' },
  { db: 'workshopId', dto: 'workshop_id' },
  { db: 'isActive', dto: 'is_active' },
  { db: 'sortOrder', dto: 'sort_order' },
  { db: 'metadataJson', dto: 'metadata_json' },
);

const USER_FIELDS = withBase(
  { db: 'login', dto: 'login' },
  { db: 'systemRole', dto: 'system_role' },
  { db: 'accessEnabled', dto: 'access_enabled' },
  { db: 'deleteRequestedAt', dto: 'delete_requested_at' },
  { db: 'deleteRequestedBy', dto: 'delete_requested_by' },
);

const USER_SECTION_ACCESS_FIELDS = withBase(
  { db: 'userId', dto: 'user_id' },
  { db: 'sectionId', dto: 'section_id' },
  { db: 'level', dto: 'level' },
);

// Словарные зеркала pull-only (план sync-mirror-dictionaries-2026-10).
const ERP_COUNTERPARTY_FIELDS = withBase(
  { db: 'name', dto: 'name' },
  { db: 'shortName', dto: 'short_name' },
  { db: 'inn', dto: 'inn' },
  { db: 'kpp', dto: 'kpp' },
  { db: 'address', dto: 'address' },
  { db: 'email', dto: 'email' },
  { db: 'phone', dto: 'phone' },
);

const ERP_CONTRACT_FIELDS = withBase(
  { db: 'number', dto: 'number' },
  { db: 'internalNumber', dto: 'internal_number' },
  { db: 'gozName', dto: 'goz_name' },
  { db: 'gozIgk', dto: 'goz_igk' },
  { db: 'gozSeparateAccountNumber', dto: 'goz_separate_account_number' },
  { db: 'gozSeparateAccountBank', dto: 'goz_separate_account_bank' },
  { db: 'gozSeparateAccount', dto: 'goz_separate_account' },
  { db: 'signedAt', dto: 'signed_at' },
  { db: 'dueAt', dto: 'due_at' },
  { db: 'customerId', dto: 'customer_id' },
  { db: 'comment', dto: 'comment' },
  { db: 'sectionsJson', dto: 'sections_json' },
  { db: 'executionPartsJson', dto: 'execution_parts_json' },
  { db: 'paymentsJson', dto: 'payments_json' },
);

const DIRECTORY_ENGINE_BRAND_FIELDS = withBase(
  { db: 'name', dto: 'name' },
  { db: 'isActive', dto: 'is_active' },
  { db: 'metadataJson', dto: 'metadata_json' },
  { db: 'deprecatedAt', dto: 'deprecated_at' },
);

const ERP_CONTRACT_PAYMENT_SLOT_FIELDS = withBase(
  { db: 'contractId', dto: 'contract_id' },
  { db: 'sectionKey', dto: 'section_key' },
  { db: 'engineBrandId', dto: 'engine_brand_id' },
  { db: 'engineId', dto: 'engine_id' },
  { db: 'contractPriceKop', dto: 'contract_price_kop' },
);

const ERP_CONTRACT_PAYMENT_FIELDS = withBase(
  { db: 'slotId', dto: 'slot_id' },
  { db: 'date', dto: 'date' },
  { db: 'amountKop', dto: 'amount_kop' },
  { db: 'kind', dto: 'kind' },
  { db: 'note', dto: 'note' },
  { db: 'countdownStart', dto: 'countdown_start' },
);

// Карточки двигателей (план engine-cards-strict-2026-10, E3). withBase добавляет
// id/created_at/updated_at/deleted_at/last_server_seq/sync_status сам.
const ERP_ENGINE_CARD_FIELDS = withBase(
  { db: 'engineNumber', dto: 'engine_number' },
  { db: 'engineInternalNumber', dto: 'engine_internal_number' },
  { db: 'engineInternalNumberYear', dto: 'engine_internal_number_year' },
  { db: 'engineBrandId', dto: 'engine_brand_id' },
  { db: 'engineBrand', dto: 'engine_brand' },
  { db: 'arrivalDate', dto: 'arrival_date' },
  { db: 'customerId', dto: 'customer_id' },
  { db: 'contractId', dto: 'contract_id' },
  { db: 'contractSectionNumber', dto: 'contract_section_number' },
  { db: 'workshopId', dto: 'workshop_id' },
  { db: 'statusReworkSent', dto: 'status_rework_sent' },
  { db: 'statusReworkSentDate', dto: 'status_rework_sent_date' },
  { db: 'statusScrapConfirmed', dto: 'status_scrap_confirmed' },
  { db: 'statusScrapConfirmedDate', dto: 'status_scrap_confirmed_date' },
  { db: 'statusRepairStarted', dto: 'status_repair_started' },
  { db: 'statusRepairStartedDate', dto: 'status_repair_started_date' },
  { db: 'statusRepaired', dto: 'status_repaired' },
  { db: 'statusRepairedDate', dto: 'status_repaired_date' },
  { db: 'statusCustomerSent', dto: 'status_customer_sent' },
  { db: 'statusCustomerSentDate', dto: 'status_customer_sent_date' },
  { db: 'statusCustomerAccepted', dto: 'status_customer_accepted' },
  { db: 'statusCustomerAcceptedDate', dto: 'status_customer_accepted_date' },
  { db: 'statusStorageReceived', dto: 'status_storage_received' },
  { db: 'statusStorageReceivedDate', dto: 'status_storage_received_date' },
  { db: 'statusRejected', dto: 'status_rejected' },
  { db: 'statusRejectedDate', dto: 'status_rejected_date' },
  { db: 'scrapReason', dto: 'scrap_reason' },
  { db: 'reclamationFlag', dto: 'reclamation_flag' },
  { db: 'reclamationAcceptedDate', dto: 'reclamation_accepted_date' },
  { db: 'reclamationCustomerReason', dto: 'reclamation_customer_reason' },
  { db: 'reclamationActualDefect', dto: 'reclamation_actual_defect' },
  { db: 'reclamationDefectNature', dto: 'reclamation_defect_nature' },
  { db: 'reclamationActNumber', dto: 'reclamation_act_number' },
  { db: 'reclamationVerdictDate', dto: 'reclamation_verdict_date' },
  { db: 'reclamationShippedDate', dto: 'reclamation_shipped_date' },
  { db: 'reclamationComment', dto: 'reclamation_comment' },
  { db: 'reclamationVerdict', dto: 'reclamation_verdict' },
  { db: 'reclamationRepairStatus', dto: 'reclamation_repair_status' },
  { db: 'repeatArrivalFlag', dto: 'repeat_arrival_flag' },
  { db: 'numberCollisionFlag', dto: 'number_collision_flag' },
  { db: 'previousArrivalId', dto: 'previous_arrival_id' },
  { db: 'mergedInto', dto: 'merged_into' },
  { db: 'arrivalInvoice', dto: 'arrival_invoice' },
  { db: 'shipmentInvoice', dto: 'shipment_invoice' },
  { db: 'engineNote', dto: 'engine_note' },
  { db: 'docsState', dto: 'docs_state' },
  { db: 'docsAspvrContractorDate', dto: 'docs_aspvr_contractor_date' },
  { db: 'docsVpSentDate', dto: 'docs_vp_sent_date' },
  { db: 'docsVpReturnedDate', dto: 'docs_vp_returned_date' },
  { db: 'docsAspvrCustomerScanDate', dto: 'docs_aspvr_customer_scan_date' },
  { db: 'docsAspvrCustomerOriginalDate', dto: 'docs_aspvr_customer_original_date' },
  { db: 'docsTrackOrAct', dto: 'docs_track_or_act' },
  { db: 'docsAspvrSignedCustomerDate', dto: 'docs_aspvr_signed_customer_date' },
  { db: 'docsAspvrCustomerReceived', dto: 'docs_aspvr_customer_received' },
  { db: 'docsReturnScanDate', dto: 'docs_return_scan_date' },
  { db: 'docsReturnOriginalDate', dto: 'docs_return_original_date' },
  { db: 'docsNote', dto: 'docs_note' },
);

// ────────────────────────────────────────────────────────────
// Registry entries
// ────────────────────────────────────────────────────────────

const ENTRIES: readonly SyncTableEntry[] = [
  {
    syncName: SyncTableName.EntityTypes,
    ledgerName: SyncTableName.EntityTypes,
    schema: entityTypeRowSchema,
    fields: ENTITY_TYPE_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  {
    syncName: SyncTableName.Entities,
    ledgerName: SyncTableName.Entities,
    schema: entityRowSchema,
    fields: ENTITY_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.EntityTypes],
  },
  {
    syncName: SyncTableName.AttributeDefs,
    ledgerName: SyncTableName.AttributeDefs,
    schema: attributeDefRowSchema,
    fields: ATTRIBUTE_DEF_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.EntityTypes],
  },
  {
    syncName: SyncTableName.AttributeValues,
    ledgerName: SyncTableName.AttributeValues,
    schema: attributeValueRowSchema,
    fields: ATTRIBUTE_VALUE_FIELDS,
    conflictTarget: ['entityId', 'attributeDefId'],
    dependsOn: [SyncTableName.Entities, SyncTableName.AttributeDefs],
  },
  {
    syncName: SyncTableName.Operations,
    ledgerName: SyncTableName.Operations,
    schema: operationRowSchema,
    fields: OPERATION_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.Entities],
  },
  {
    syncName: SyncTableName.AuditLog,
    ledgerName: SyncTableName.AuditLog,
    schema: auditLogRowSchema,
    fields: AUDIT_LOG_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  {
    syncName: SyncTableName.ChatMessages,
    ledgerName: SyncTableName.ChatMessages,
    schema: chatMessageRowSchema,
    fields: CHAT_MESSAGE_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  {
    syncName: SyncTableName.ChatReads,
    ledgerName: SyncTableName.ChatReads,
    schema: chatReadRowSchema,
    fields: CHAT_READ_FIELDS,
    conflictTarget: ['messageId', 'userId'],
    dependsOn: [SyncTableName.ChatMessages],
  },
  {
    syncName: SyncTableName.ChatRooms,
    ledgerName: SyncTableName.ChatRooms,
    schema: chatRoomRowSchema,
    fields: CHAT_ROOM_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  {
    syncName: SyncTableName.UserPresence,
    ledgerName: SyncTableName.UserPresence,
    schema: userPresenceRowSchema,
    fields: USER_PRESENCE_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  {
    syncName: SyncTableName.Notes,
    ledgerName: SyncTableName.Notes,
    schema: noteRowSchema,
    fields: NOTE_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  {
    syncName: SyncTableName.NoteShares,
    ledgerName: SyncTableName.NoteShares,
    schema: noteShareRowSchema,
    fields: NOTE_SHARE_FIELDS,
    conflictTarget: ['noteId', 'recipientUserId'],
    dependsOn: [SyncTableName.Notes],
  },
  {
    syncName: SyncTableName.CardDrafts,
    ledgerName: SyncTableName.CardDrafts,
    schema: cardDraftRowSchema,
    fields: CARD_DRAFT_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  {
    syncName: SyncTableName.AiChatRequests,
    ledgerName: SyncTableName.AiChatRequests,
    schema: aiChatRequestRowSchema,
    fields: AI_CHAT_REQUEST_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  {
    syncName: SyncTableName.ErpNomenclature,
    ledgerName: SyncTableName.ErpNomenclature,
    schema: erpNomenclatureRowSchema,
    fields: ERP_NOMENCLATURE_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.Entities],
  },
  {
    syncName: SyncTableName.ErpEngineAssemblyBom,
    ledgerName: SyncTableName.ErpEngineAssemblyBom,
    schema: erpEngineAssemblyBomRowSchema,
    fields: ERP_ENGINE_ASSEMBLY_BOM_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.Entities, SyncTableName.ErpNomenclature],
  },
  {
    syncName: SyncTableName.ErpEngineAssemblyBomLines,
    ledgerName: SyncTableName.ErpEngineAssemblyBomLines,
    schema: erpEngineAssemblyBomLineRowSchema,
    fields: ERP_ENGINE_ASSEMBLY_BOM_LINE_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.ErpEngineAssemblyBom, SyncTableName.ErpNomenclature],
  },
  {
    syncName: SyncTableName.ErpEngineAssemblyBomBrandLinks,
    ledgerName: SyncTableName.ErpEngineAssemblyBomBrandLinks,
    schema: erpEngineAssemblyBomBrandLinkRowSchema,
    fields: ERP_ENGINE_ASSEMBLY_BOM_BRAND_LINK_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.ErpEngineAssemblyBom, SyncTableName.Entities],
  },
  {
    syncName: SyncTableName.ErpEngineInstances,
    ledgerName: SyncTableName.ErpEngineInstances,
    schema: erpEngineInstanceRowSchema,
    fields: ERP_ENGINE_INSTANCE_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.ErpNomenclature],
  },
  {
    syncName: SyncTableName.ErpRegStockBalance,
    ledgerName: SyncTableName.ErpRegStockBalance,
    schema: erpRegisterStockBalanceRowSchema,
    fields: ERP_STOCK_BALANCE_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.ErpNomenclature],
  },
  {
    syncName: SyncTableName.ErpRegStockMovements,
    ledgerName: SyncTableName.ErpRegStockMovements,
    schema: erpRegisterStockMovementRowSchema,
    fields: ERP_STOCK_MOVEMENT_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.ErpNomenclature],
  },
  // Список деталей двигателя построчно. Зависит от листа (operations.id — родитель) и от
  // двигателя; строгой FK на деталь нет сознательно (legacy-строки ссылаются на детали
  // разных эпох справочника), поэтому в dependsOn её и нет.
  {
    syncName: SyncTableName.ErpEngineInventoryLines,
    ledgerName: SyncTableName.ErpEngineInventoryLines,
    schema: erpEngineInventoryLineRowSchema,
    fields: ERP_ENGINE_INVENTORY_LINE_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.Operations, SyncTableName.Entities],
  },
  // B3/R3. conflictTarget у доступов — ['id'], НЕ ['userId','sectionId']: синк
  // ключует строку по row_id (0086 §доступы). dependsOn задаёт и порядок таблиц
  // в холодном full-state: доступы обязаны ехать ПОСЛЕ аккаунтов, иначе
  // клиентская чистка FK-сирот снесёт их как строки без родителя.
  // users НЕ зависит от entities: FK на entities в 0086 сознательно нет.
  {
    syncName: SyncTableName.WarehouseLocations,
    ledgerName: SyncTableName.WarehouseLocations,
    schema: warehouseLocationRowSchema,
    fields: WAREHOUSE_LOCATION_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  // Словарные зеркала pull-only: контракты после контрагентов (FK customer_id) —
  // тот же приём, что доступы после аккаунтов: иначе чистка FK-сирот снесёт строки.
  {
    syncName: SyncTableName.ErpCounterparties,
    ledgerName: SyncTableName.ErpCounterparties,
    schema: erpCounterpartyRowSchema,
    fields: ERP_COUNTERPARTY_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  {
    syncName: SyncTableName.ErpContracts,
    ledgerName: SyncTableName.ErpContracts,
    schema: erpContractRowSchema,
    fields: ERP_CONTRACT_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.ErpCounterparties],
  },
  {
    syncName: SyncTableName.DirectoryEngineBrands,
    ledgerName: SyncTableName.DirectoryEngineBrands,
    schema: directoryEngineBrandRowSchema,
    fields: DIRECTORY_ENGINE_BRAND_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  {
    syncName: SyncTableName.Users,
    ledgerName: SyncTableName.Users,
    schema: userRowSchema,
    fields: USER_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
  {
    syncName: SyncTableName.UserSectionAccess,
    ledgerName: SyncTableName.UserSectionAccess,
    schema: userSectionAccessRowSchema,
    fields: USER_SECTION_ACCESS_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.Users],
  },
  // Платежи контрактов (contract-payments-strict-2026-10): слоты после контрактов
  // (FK contract_id), строки платежей после слотов — порядок холодного full-state.
  {
    syncName: SyncTableName.ErpContractPaymentSlots,
    ledgerName: SyncTableName.ErpContractPaymentSlots,
    schema: erpContractPaymentSlotRowSchema,
    fields: ERP_CONTRACT_PAYMENT_SLOT_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.ErpContracts],
  },
  {
    syncName: SyncTableName.ErpContractPaymentPayments,
    ledgerName: SyncTableName.ErpContractPaymentPayments,
    schema: erpContractPaymentRowSchema,
    fields: ERP_CONTRACT_PAYMENT_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [SyncTableName.ErpContractPaymentSlots],
  },
  // Карточки двигателей (план engine-cards-strict-2026-10, E3). Ссылки — uuid без
  // жёстких FK (наследие E1): dependsOn пуст, сирот не чистим, отсутствующий
  // справочник — прочерк в UI, а не снос строки.
  {
    syncName: SyncTableName.ErpEngineCards,
    ledgerName: SyncTableName.ErpEngineCards,
    schema: erpEngineCardRowSchema,
    fields: ERP_ENGINE_CARD_FIELDS,
    conflictTarget: ['id'],
    dependsOn: [],
  },
] as const;

// ────────────────────────────────────────────────────────────
// Lookup maps (built once, cached)
// ────────────────────────────────────────────────────────────

const bySyncName = new Map<SyncTableName, SyncTableEntry>(
  ENTRIES.map((e) => [e.syncName, e]),
);

const byLedgerName = new Map<string, SyncTableEntry>(
  ENTRIES.map((e) => [e.ledgerName, e]),
);

// ────────────────────────────────────────────────────────────
// Row conversion helpers (pure, no DB dependency)
// ────────────────────────────────────────────────────────────

/**
 * Convert a DB row (camelCase keys) to a sync DTO row (snake_case keys).
 * Unknown fields in the source that are not in the mapping are dropped.
 */
export function toSyncRow(tableName: SyncTableName, dbRow: Record<string, unknown>): Record<string, unknown> {
  const entry = bySyncName.get(tableName);
  if (!entry) throw new Error(`Unknown sync table: ${tableName}`);
  const result: Record<string, unknown> = {};
  for (const f of entry.fields) {
    const val = dbRow[f.db];
    if (val !== undefined) {
      result[f.dto] = val;
    }
  }
  return result;
}

/**
 * Convert a sync DTO row (snake_case keys) to a DB row (camelCase keys).
 * Unknown fields in the source that are not in the mapping are dropped.
 */
export function toDbRow(tableName: SyncTableName, dtoRow: Record<string, unknown>): Record<string, unknown> {
  const entry = bySyncName.get(tableName);
  if (!entry) throw new Error(`Unknown sync table: ${tableName}`);
  const result: Record<string, unknown> = {};
  for (const f of entry.fields) {
    const val = dtoRow[f.dto];
    if (val !== undefined) {
      result[f.db] = val;
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────
// SyncTableRegistry API
// ────────────────────────────────────────────────────────────

export const SyncTableRegistry = {
  /** All entries in topological (dependency-safe) order. */
  entries(): readonly SyncTableEntry[] {
    return ENTRIES;
  },

  /** All SyncTableName values in dependency-safe order. */
  tableNames(): readonly SyncTableName[] {
    return ENTRIES.map((e) => e.syncName);
  },

  /** Lookup by SyncTableName. */
  get(name: SyncTableName): SyncTableEntry | undefined {
    return bySyncName.get(name);
  },

  /** Lookup by ledger table name string. */
  getByLedgerName(name: string): SyncTableEntry | undefined {
    return byLedgerName.get(name);
  },

  /** Check if a table name is a known sync table. */
  isSyncTable(name: string): name is SyncTableName {
    return bySyncName.has(name as SyncTableName);
  },

  /** Map SyncTableName -> LedgerTableName (string). */
  toLedgerName(syncName: SyncTableName): string {
    const entry = bySyncName.get(syncName);
    if (!entry) throw new Error(`Unknown sync table: ${syncName}`);
    return entry.ledgerName;
  },

  /** Validate a DTO row against the table's Zod schema. */
  validate(tableName: SyncTableName, row: unknown): boolean {
    const entry = bySyncName.get(tableName);
    if (!entry) return false;
    return entry.schema.safeParse(row).success;
  },

  /** Convert DB row (camelCase) -> DTO row (snake_case). */
  toSyncRow,

  /** Convert DTO row (snake_case) -> DB row (camelCase). */
  toDbRow,
} as const;
