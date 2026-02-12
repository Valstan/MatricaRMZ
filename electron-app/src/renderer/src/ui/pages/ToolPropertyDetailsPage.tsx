import React, { useEffect, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SuggestInput } from '../components/SuggestInput.js';

export function ToolPropertyDetailsPage(props: {
  id: string;
  onBack: () => void;
  canEdit: boolean;
}) {
  const [status, setStatus] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [params, setParams] = useState<string>('');
  const [paramHints, setParamHints] = useState<string[]>([]);

  async function refresh() {
    try {
      setStatus('Загрузка...');
      const r = await window.matrica.tools.properties.get(props.id);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      const attrs = (r as any).property?.attributes ?? {};
      setName(String(attrs.name ?? ''));
      setParams(String(attrs.params ?? ''));
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  useEffect(() => {
    void refresh();
  }, [props.id]);

  useEffect(() => {
    void window.matrica.tools.properties.list().then((r: any) => {
      if (!r?.ok) {
        setParamHints([]);
        return;
      }
      const values: string[] = Array.isArray(r.items)
        ? r.items.map((x: any) => String(x?.params ?? '').trim()).filter(Boolean)
        : [];
      setParamHints(Array.from(new Set(values)).sort((a, b) => a.localeCompare(b, 'ru')));
    });
  }, [props.id]);

  async function saveAttr(code: string, value: unknown) {
    if (!props.canEdit) return;
    const r = await window.matrica.tools.properties.setAttr({ id: props.id, code, value });
    if (!r.ok) setStatus(`Ошибка: ${r.error}`);
    else setStatus('');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button variant="ghost" onClick={props.onBack}>
          Назад
        </Button>
        <strong>Карточка свойства инструмента</strong>
      </div>

      {status && <div style={{ color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div className="card-panel" style={{ display: 'grid', gap: 8 }}>
        <div className="card-row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, padding: '4px 6px' }}>
          <div>Наименование свойства</div>
          <Input
            value={name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            onBlur={() => void saveAttr('name', name.trim())}
            placeholder="Например: Материал"
            disabled={!props.canEdit}
          />
        </div>
        <div className="card-row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, padding: '4px 6px' }}>
          <div>Параметры свойства</div>
          <SuggestInput
            value={params}
            onChange={setParams}
            options={paramHints.map((v) => ({ value: v }))}
            onBlur={() => void saveAttr('params', params.trim())}
            placeholder="Например: сталь 45"
            disabled={!props.canEdit}
          />
        </div>
      </div>
    </div>
  );
}
