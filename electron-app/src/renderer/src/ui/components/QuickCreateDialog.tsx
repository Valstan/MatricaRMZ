import React, { useState } from 'react';

import type { EntityReferenceTarget, QuickCreateRequest, QuickCreateResult } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';

const ARTICLE_TARGETS = new Set<EntityReferenceTarget>(['nomenclature', 'part', 'product']);

export function QuickCreateDialog(props: {
  target: EntityReferenceTarget;
  targetLabel: string;
  initialLabel: string;
  onSubmit: (request: QuickCreateRequest) => Promise<QuickCreateResult | null>;
  onClose: (result: QuickCreateResult | null) => void;
}) {
  const [name, setName] = useState(props.initialLabel);
  const [article, setArticle] = useState('');
  const [withoutArticle, setWithoutArticle] = useState(false);
  const [unit, setUnit] = useState('шт');
  const [price, setPrice] = useState('0');
  const [inn, setInn] = useState('');
  const [kpp, setKpp] = useState('');
  const [phone, setPhone] = useState('');
  const [abbreviation, setAbbreviation] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    const cleanName = name.trim();
    if (!cleanName) {
      setError('Введите наименование');
      return;
    }
    if (ARTICLE_TARGETS.has(props.target) && !withoutArticle && !article.trim()) {
      setError('Введите артикул или отметьте «Без артикула»');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const fields: Record<string, string | number | boolean | null> = { name: cleanName };
      if (ARTICLE_TARGETS.has(props.target)) {
        fields.article = withoutArticle ? null : article.trim();
        fields.withoutArticle = withoutArticle;
        fields.unit = unit.trim() || 'шт';
      } else if (props.target === 'service') {
        fields.unit = unit.trim() || 'шт';
        fields.price = Math.max(0, Number(price) || 0);
      } else if (props.target === 'customer') {
        fields.inn = inn.trim();
        fields.kpp = kpp.trim();
        fields.phone = phone.trim();
      } else if (props.target === 'unit') {
        fields.abbreviation = abbreviation.trim();
      } else if (props.target === 'department' || props.target === 'section' || props.target === 'workshop') {
        fields.code = code.trim();
      }
      const result = await props.onSubmit({ target: props.target, label: cleanName, fields });
      if (!result) {
        setError('Не удалось создать элемент');
        return;
      }
      props.onClose(result);
    } catch (cause) {
      setError(String(cause ?? '').replace(/^Error:\s*/i, '') || 'Не удалось создать элемент');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="presentation"
      style={{ position: 'fixed', inset: 0, zIndex: 4100, background: 'rgba(15,23,42,.45)', display: 'grid', placeItems: 'center', padding: 16 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) props.onClose(null);
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={`Создать: ${props.targetLabel}`} style={{ width: 'min(520px, 100%)', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)', padding: 18, display: 'grid', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 17 }}>Создать: {props.targetLabel.toLocaleLowerCase('ru-RU')}</div>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Наименование</span>
          <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} disabled={busy} />
        </label>
        {ARTICLE_TARGETS.has(props.target) ? (
          <>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Артикул</span>
              <Input value={article} onChange={(event) => setArticle(event.target.value)} disabled={busy || withoutArticle} />
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={withoutArticle} onChange={(event) => setWithoutArticle(event.target.checked)} disabled={busy} />
              Без артикула
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Единица</span>
              <Input value={unit} onChange={(event) => setUnit(event.target.value)} disabled={busy} />
            </label>
          </>
        ) : null}
        {props.target === 'service' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={{ display: 'grid', gap: 4 }}><span style={{ fontSize: 12, color: 'var(--subtle)' }}>Единица</span><Input value={unit} onChange={(event) => setUnit(event.target.value)} disabled={busy} /></label>
            <label style={{ display: 'grid', gap: 4 }}><span style={{ fontSize: 12, color: 'var(--subtle)' }}>Цена</span><Input type="number" min="0" value={price} onChange={(event) => setPrice(event.target.value)} disabled={busy} /></label>
          </div>
        ) : null}
        {props.target === 'customer' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={{ display: 'grid', gap: 4 }}><span style={{ fontSize: 12, color: 'var(--subtle)' }}>ИНН</span><Input value={inn} onChange={(event) => setInn(event.target.value)} disabled={busy} /></label>
            <label style={{ display: 'grid', gap: 4 }}><span style={{ fontSize: 12, color: 'var(--subtle)' }}>КПП</span><Input value={kpp} onChange={(event) => setKpp(event.target.value)} disabled={busy} /></label>
            <label style={{ display: 'grid', gap: 4, gridColumn: '1 / -1' }}><span style={{ fontSize: 12, color: 'var(--subtle)' }}>Телефон</span><Input value={phone} onChange={(event) => setPhone(event.target.value)} disabled={busy} /></label>
          </div>
        ) : null}
        {props.target === 'unit' ? <label style={{ display: 'grid', gap: 4 }}><span style={{ fontSize: 12, color: 'var(--subtle)' }}>Сокращение</span><Input value={abbreviation} onChange={(event) => setAbbreviation(event.target.value)} disabled={busy} /></label> : null}
        {props.target === 'department' || props.target === 'section' || props.target === 'workshop' ? <label style={{ display: 'grid', gap: 4 }}><span style={{ fontSize: 12, color: 'var(--subtle)' }}>Код</span><Input value={code} onChange={(event) => setCode(event.target.value)} disabled={busy} /></label> : null}
        {error ? <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" disabled={busy} onClick={() => props.onClose(null)}>Отмена</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? 'Создание…' : 'Создать'}</Button>
        </div>
      </div>
    </div>
  );
}
