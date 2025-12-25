export type RepairChecklistTemplateItem = {
  id: string;
  label: string;
  kind: 'text' | 'date' | 'boolean' | 'table' | 'signature';
  required?: boolean;
  // Для kind=table: колонки и дефолтные строки (если нужны)
  columns?: { id: string; label: string }[];
};

export type RepairChecklistTemplate = {
  id: string;
  code: string;
  name: string;
  // стадия процесса: для MVP используем 'repair'
  stage: string;
  version: number;
  active: boolean;
  items: RepairChecklistTemplateItem[];
};

export type RepairChecklistTableRow = Record<string, string>;

export type RepairChecklistAnswers = Record<
  string,
  | { kind: 'text'; value: string }
  | { kind: 'date'; value: number | null } // ms unix-time
  | { kind: 'boolean'; value: boolean }
  | { kind: 'table'; rows: RepairChecklistTableRow[] }
  | { kind: 'signature'; fio: string; position: string; signedAt: number | null }
>;

// То, что кладём в operations.metaJson
export type RepairChecklistPayload = {
  kind: 'repair_checklist';
  templateId: string;
  templateVersion: number;
  stage: string;
  engineEntityId: string;
  filledBy: string | null;
  filledAt: number | null;
  answers: RepairChecklistAnswers;
};


