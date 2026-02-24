import React, { useEffect, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SuggestInput } from '../components/SuggestInput.js';
import { SectionCard } from '../components/SectionCard.js';
import { CardActionBar } from '../components/CardActionBar.js';
import type { CardCloseActions } from '../cardCloseTypes.js';

export function ToolPropertyDetailsPage(props: {
  id: string;
  onBack: () => void;
  canEdit: boolean;
  registerCardCloseActions?: (actions: CardCloseActions | null) => void;
  requestClose?: () => void;
}) {
  const [status, setStatus] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [params, setParams] = useState<string>('');
  const [paramHints, setParamHints] = useState<string[]>([]);
  const dirtyRef = useRef(false);

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
      dirtyRef.current = false;
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

  useEffect(() => {
    if (!props.registerCardCloseActions) return;
    props.registerCardCloseActions({
      isDirty: () => dirtyRef.current,
      saveAndClose: async () => {
        await saveAttr('name', name.trim());
        await saveAttr('params', params.trim());
        dirtyRef.current = false;
      },
      closeWithoutSave: () => {
        dirtyRef.current = false;
      },
      copyToNew: async () => {
        const r = await window.matrica.tools.properties.create();
        if (r?.ok && r.id) {
          await window.matrica.tools.properties.setAttr({ id: r.id, code: 'name', value: name.trim() });
          await window.matrica.tools.properties.setAttr({ id: r.id, code: 'params', value: params.trim() });
        }
      },
    });
    return () => { props.registerCardCloseActions?.(null); };
  }, [name, params, props.registerCardCloseActions]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <CardActionBar
        canEdit={props.canEdit}
        onCopyToNew={() => {
          void (async () => {
            const r = await window.matrica.tools.properties.create();
            if (r?.ok && r.id) {
              await window.matrica.tools.properties.setAttr({ id: r.id, code: 'name', value: name.trim() });
              await window.matrica.tools.properties.setAttr({ id: r.id, code: 'params', value: params.trim() });
            }
          })();
        }}
        onSaveAndClose={() => {
          void (async () => {
            await saveAttr('name', name.trim());
            await saveAttr('params', params.trim());
            dirtyRef.current = false;
            props.onBack();
          })();
        }}
        onCloseWithoutSave={() => {
          dirtyRef.current = false;
          props.onBack();
        }}
        onClose={() => props.requestClose?.()}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button variant="ghost" onClick={props.onBack}>
          Назад
        </Button>
        <strong>Карточка свойства инструмента</strong>
      </div>

      {status && <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>}

      <SectionCard>
        <div className="card-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) minmax(0, 1fr)', gap: 8, padding: '4px 6px' }}>
          <div>Наименование свойства</div>
          <Input
            value={name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setName(e.target.value);
              dirtyRef.current = true;
            }}
            onBlur={() => {
              void saveAttr('name', name.trim());
              dirtyRef.current = false;
            }}
            placeholder="Например: Материал"
            disabled={!props.canEdit}
          />
        </div>
        <div className="card-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) minmax(0, 1fr)', gap: 8, padding: '4px 6px' }}>
          <div>Параметры свойства</div>
          <SuggestInput
            value={params}
            onChange={(v) => {
              setParams(v);
              dirtyRef.current = true;
            }}
            options={paramHints.map((v) => ({ value: v }))}
            onBlur={() => {
              void saveAttr('params', params.trim());
              dirtyRef.current = false;
            }}
            placeholder="Например: сталь 45"
            disabled={!props.canEdit}
          />
        </div>
      </SectionCard>
    </div>
  );
}
