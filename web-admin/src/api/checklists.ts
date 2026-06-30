import { apiJson } from './client.js';

export function listChecklistTemplates(stage?: string) {
  const params = stage ? `?stage=${encodeURIComponent(stage)}` : '';
  return apiJson(`/checklists/templates${params}`, { method: 'GET' });
}

export function getEngineChecklist(args: { engineId: string; stage: string }) {
  const params = new URLSearchParams({ engineId: args.engineId, stage: args.stage });
  return apiJson(`/checklists/engine?${params.toString()}`, { method: 'GET' });
}

export function saveEngineChecklist(args: {
  engineId: string;
  stage: string;
  templateId: string;
  operationId?: string | null;
  answers: any;
  attachments?: any[];
}) {
  return apiJson('/checklists/engine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}
