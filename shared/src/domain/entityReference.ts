export type EntityReferenceTarget =
  | 'engine'
  | 'engine_brand'
  | 'nomenclature'
  | 'part'
  | 'product'
  | 'service'
  | 'customer'
  | 'contract'
  | 'employee'
  | 'unit'
  | 'department'
  | 'section'
  | 'warehouse'
  | 'workshop'
  | 'work_order'
  | 'supply_request'
  | 'stock_document'
  | 'category'
  | 'store'
  | 'engine_node'
  | 'tool'
  | 'tool_property'
  | 'tool_catalog'
  | 'part_engine_brand'
  | 'engine_brand_group'
  | 'ui_screen'
  | 'link_field_rule'
  | 'part_template'
  | 'nomenclature_template'
  | 'nomenclature_group'
  | 'bom_component_type';

export type QuickCreateRequest = {
  target: EntityReferenceTarget;
  label: string;
  fields?: Record<string, string | number | boolean | null>;
};

export type QuickCreateResult = {
  id: string;
  label: string;
  existing: boolean;
};

export type InvalidReferenceIssue = {
  path: string;
  expectedType: EntityReferenceTarget;
  referenceId: string | null;
  reason: 'missing_id' | 'not_found' | 'wrong_type' | 'not_allowed' | 'unresolved_text';
};

export type EntityReferenceCandidate = {
  path: string;
  expectedType: EntityReferenceTarget;
  referenceId: string;
};

type WorkOrderReferencePayload = {
  version?: number;
  assemblyEngineId?: string | null;
  crew?: Array<{ employeeId?: string | null }>;
  freeWorks?: Array<Record<string, unknown>>;
  works?: Array<Record<string, unknown>>;
  workGroups?: Array<{ partId?: string | null; lines?: Array<Record<string, unknown>> }>;
  signatureBlocks?: Array<{ slots?: Array<{ employeeId?: string | null }> }>;
};

function addCandidate(
  result: EntityReferenceCandidate[],
  path: string,
  expectedType: EntityReferenceTarget,
  rawId: unknown,
) {
  const referenceId = String(rawId ?? '').trim();
  if (referenceId) result.push({ path, expectedType, referenceId });
}

function collectWorkLineReferences(result: EntityReferenceCandidate[], prefix: string, line: Record<string, unknown>) {
  addCandidate(result, `${prefix}.serviceId`, 'service', line.serviceId);
  addCandidate(result, `${prefix}.partId`, 'part', line.partId);
  addCandidate(result, `${prefix}.engineId`, 'engine', line.engineId);
  addCandidate(result, `${prefix}.engineBrandId`, 'engine_brand', line.engineBrandId);
}

export function collectWorkOrderEntityReferences(payload: WorkOrderReferencePayload): EntityReferenceCandidate[] {
  const result: EntityReferenceCandidate[] = [];
  addCandidate(result, 'assemblyEngineId', 'engine', payload.assemblyEngineId);
  for (const [index, member] of (payload.crew ?? []).entries()) {
    addCandidate(result, `crew[${index}].employeeId`, 'employee', member.employeeId);
  }
  for (const collection of ['freeWorks', 'works'] as const) {
    for (const [index, line] of (payload[collection] ?? []).entries()) {
      collectWorkLineReferences(result, `${collection}[${index}]`, line);
    }
  }
  for (const [groupIndex, group] of (payload.workGroups ?? []).entries()) {
    addCandidate(result, `workGroups[${groupIndex}].partId`, 'part', group.partId);
    for (const [lineIndex, line] of (group.lines ?? []).entries()) {
      collectWorkLineReferences(result, `workGroups[${groupIndex}].lines[${lineIndex}]`, line);
    }
  }
  for (const [blockIndex, block] of (payload.signatureBlocks ?? []).entries()) {
    for (const [slotIndex, slot] of (block.slots ?? []).entries()) {
      addCandidate(result, `signatureBlocks[${blockIndex}].slots[${slotIndex}].employeeId`, 'employee', slot.employeeId);
    }
  }
  return result;
}

export function collectWorkOrderUnresolvedTextIssues(
  payload: WorkOrderReferencePayload,
  previous?: WorkOrderReferencePayload | null,
): InvalidReferenceIssue[] {
  if (Number(payload.version ?? 0) < 4) return [];
  const issues: InvalidReferenceIssue[] = [];
  const collections = ['freeWorks', 'works'] as const;
  for (const collection of collections) {
    const previousLines = previous?.[collection] ?? [];
    for (const [index, line] of (payload[collection] ?? []).entries()) {
      const serviceName = String(line.serviceName ?? '').trim();
      const serviceId = String(line.serviceId ?? '').trim();
      if (!serviceName || serviceId) continue;
      const previousLine = previousLines[index];
      const unchangedLegacy =
        previousLine &&
        !String(previousLine.serviceId ?? '').trim() &&
        String(previousLine.serviceName ?? '').trim() === serviceName;
      if (unchangedLegacy) continue;
      issues.push({
        path: `${collection}[${index}].serviceId`,
        expectedType: 'service',
        referenceId: null,
        reason: 'unresolved_text',
      });
    }
  }
  return issues;
}
