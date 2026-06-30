import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

type Layer = 'dictionary' | 'cards' | 'documents' | 'registers' | 'journals';
type DictionaryModule = 'parts' | 'tools' | 'counterparties' | 'contracts' | 'employees';
type CardModule = 'parts' | 'tools' | 'employees';

const LAYER_LABELS: Record<Layer, string> = {
  dictionary: 'Справочники',
  cards: 'Карточки',
  documents: 'Документы',
  registers: 'Регистры/Списки',
  journals: 'Журналы',
};

const DICTIONARY_LABELS: Record<DictionaryModule, string> = {
  parts: 'Номенклатура деталей',
  tools: 'Инструмент',
  counterparties: 'Контрагенты',
  contracts: 'Договоры',
  employees: 'Сотрудники',
};

const CARD_LABELS: Record<CardModule, string> = {
  parts: 'Карточки деталей',
  tools: 'Карточки инструмента',
  employees: 'Карточки сотрудников',
};

export function ErpWorkspacePanel(props: { canEdit: boolean }) {
  const [layer, setLayer] = useState<Layer>('dictionary');
  const [dictionaryModule, setDictionaryModule] = useState<DictionaryModule>('parts');
  const [cardModule, setCardModule] = useState<CardModule>('parts');
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [status, setStatus] = useState('');
  const [dictCode, setDictCode] = useState('');
  const [dictName, setDictName] = useState('');
  const [cardTemplateId, setCardTemplateId] = useState('');
  const [cardNo, setCardNo] = useState('');
  const [cardSerial, setCardSerial] = useState('');
  const [cardFullName, setCardFullName] = useState('');
  const [docNo, setDocNo] = useState('');
  const [docPartCardId, setDocPartCardId] = useState('');
  const [docQty, setDocQty] = useState('1');
  const [documents, setDocuments] = useState<Array<Record<string, unknown>>>([]);

  const title = useMemo(() => `${LAYER_LABELS[layer]} ERP`, [layer]);

  async function reloadDictionary() {
    const r = await window.matrica.erp.dictionaryList(dictionaryModule);
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      setRows([]);
      return;
    }
    setRows(r.rows ?? []);
  }

  async function reloadCards() {
    const r = await window.matrica.erp.cardsList(cardModule);
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      setRows([]);
      return;
    }
    setRows(r.rows ?? []);
  }

  async function reloadDocuments() {
    const r = await window.matrica.erp.documentsList();
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      setDocuments([]);
      return;
    }
    setDocuments(r.rows ?? []);
  }

  useEffect(() => {
    if (layer === 'dictionary') void reloadDictionary();
    if (layer === 'cards') void reloadCards();
    if (layer === 'documents') void reloadDocuments();
  }, [layer, dictionaryModule, cardModule]);

  async function createDictionary() {
    const code = dictCode.trim();
    const name = dictName.trim();
    if (!code || !name) return;
    const r = await window.matrica.erp.dictionaryUpsert({ moduleName: dictionaryModule, code, name });
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      return;
    }
    setDictCode('');
    setDictName('');
    setStatus('Справочник сохранен');
    await reloadDictionary();
  }

  async function createCard() {
    if (cardModule === 'employees') {
      const fullName = cardFullName.trim();
      if (!fullName) return;
      const r = await window.matrica.erp.cardsUpsert({ moduleName: 'employees', fullName });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
        return;
      }
      setCardFullName('');
      setStatus('Карточка сотрудника создана');
      await reloadCards();
      return;
    }
    const templateId = cardTemplateId.trim();
    if (!templateId) {
      setStatus('Укажите templateId');
      return;
    }
    const r = await window.matrica.erp.cardsUpsert({
      moduleName: cardModule,
      templateId,
      cardNo: cardNo.trim() || null,
      serialNo: cardSerial.trim() || null,
      status: 'active',
    });
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      return;
    }
    setCardTemplateId('');
    setCardNo('');
    setCardSerial('');
    setStatus('Карточка создана');
    await reloadCards();
  }

  async function createAndPostReceipt() {
    const qty = Math.max(1, Math.trunc(Number(docQty || 1)));
    const partCardId = docPartCardId.trim();
    const number = docNo.trim() || `REC-${Date.now()}`;
    if (!partCardId) {
      setStatus('Укажите partCardId');
      return;
    }
    const created = await window.matrica.erp.documentsCreate({
      docType: 'parts_receipt',
      docNo: number,
      lines: [{ partCardId, qty }],
    });
    if (!created.ok) {
      setStatus(`Ошибка: ${created.error ?? 'unknown'}`);
      return;
    }
    const posted = await window.matrica.erp.documentsPost(created.id);
    if (!posted.ok) {
      setStatus(`Документ создан, но не проведен: ${posted.error ?? 'unknown'}`);
      return;
    }
    setDocNo('');
    setDocPartCardId('');
    setDocQty('1');
    setStatus('Документ создан и проведен');
    await reloadDocuments();
  }

  return (
    <div style={{ border: '1px solid #dbeafe', background: '#f8fbff', padding: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {Object.keys(LAYER_LABELS).map((item) => {
          const id = item as Layer;
          const active = layer === id;
          return (
            <Button
              key={id}
              variant="ghost"
              onClick={() => setLayer(id)}
              style={active ? { background: '#1e3a8a', color: '#fff', border: '1px solid #1e3a8a' } : undefined}
            >
              {LAYER_LABELS[id]}
            </Button>
          );
        })}
      </div>

      <div style={{ marginTop: 10, fontWeight: 800 }}>{title}</div>
      <div style={{ marginTop: 4, color: '#475569', fontSize: 12 }}>
        ERP-блок вспомогательный. Основные рабочие справочники настраиваются в секции ниже.
      </div>

      {layer === 'dictionary' && (
        <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['parts', 'tools', 'counterparties', 'contracts', 'employees'] as const).map((m) => (
              <Button key={m} variant="ghost" onClick={() => setDictionaryModule(m)} style={dictionaryModule === m ? { border: '1px solid #2563eb' } : undefined}>
                {DICTIONARY_LABELS[m]}
              </Button>
            ))}
          </div>
          {props.canEdit && (
            <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr auto', gap: 8 }}>
              <Input value={dictCode} onChange={(e) => setDictCode(e.target.value)} placeholder="code" />
              <Input value={dictName} onChange={(e) => setDictName(e.target.value)} placeholder="name" />
              <Button onClick={() => void createDictionary()}>Добавить</Button>
            </div>
          )}
        </div>
      )}

      {layer === 'cards' && (
        <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['parts', 'tools', 'employees'] as const).map((m) => (
              <Button key={m} variant="ghost" onClick={() => setCardModule(m)} style={cardModule === m ? { border: '1px solid #2563eb' } : undefined}>
                {CARD_LABELS[m]}
              </Button>
            ))}
          </div>
          {props.canEdit &&
            (cardModule === 'employees' ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
                <Input value={cardFullName} onChange={(e) => setCardFullName(e.target.value)} placeholder="ФИО сотрудника" />
                <Button onClick={() => void createCard()}>Создать карточку</Button>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 8 }}>
                <Input value={cardTemplateId} onChange={(e) => setCardTemplateId(e.target.value)} placeholder="templateId" />
                <Input value={cardNo} onChange={(e) => setCardNo(e.target.value)} placeholder="cardNo" />
                <Input value={cardSerial} onChange={(e) => setCardSerial(e.target.value)} placeholder="serialNo" />
                <Button onClick={() => void createCard()}>Создать карточку</Button>
              </div>
            ))}
        </div>
      )}

      {layer === 'documents' && (
        <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
          {props.canEdit && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 120px auto', gap: 8 }}>
              <Input value={docNo} onChange={(e) => setDocNo(e.target.value)} placeholder="docNo (например REC-001)" />
              <Input value={docPartCardId} onChange={(e) => setDocPartCardId(e.target.value)} placeholder="partCardId" />
              <Input value={docQty} onChange={(e) => setDocQty(e.target.value)} placeholder="qty" />
              <Button onClick={() => void createAndPostReceipt()}>Создать+Провести приход</Button>
            </div>
          )}
          <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid #e5e7eb', padding: 6 }}>
            {documents.map((d) => (
              <div key={String(d.id)} style={{ padding: '4px 0', borderBottom: '1px solid #f1f5f9' }}>
                {String(d.docNo ?? d.id)} | {String(d.docType ?? '')} | {String(d.status ?? '')}
              </div>
            ))}
            {documents.length === 0 && <div style={{ color: '#64748b' }}>Нет документов</div>}
          </div>
        </div>
      )}

      {layer === 'registers' && (
        <div style={{ marginTop: 8, color: '#334155' }}>
          Регистры формируются при проведении документов: остатки, использование деталей, взаиморасчеты.
        </div>
      )}

      {layer === 'journals' && (
        <div style={{ marginTop: 8, color: '#334155' }}>
          Журналы ERP фиксируют события документов (создано/проведено) для контроля и аудита.
        </div>
      )}

      {rows.length > 0 && layer !== 'documents' && (
        <div style={{ marginTop: 8, maxHeight: 180, overflow: 'auto', border: '1px solid #e5e7eb', padding: 6 }}>
          {rows.map((row) => (
            <div key={String(row.id)} style={{ padding: '4px 0', borderBottom: '1px solid #f1f5f9' }}>
              {String(row.name ?? row.fullName ?? row.code ?? row.id)}
            </div>
          ))}
        </div>
      )}

      {status && <div style={{ marginTop: 8, color: '#475569', fontSize: 12 }}>{status}</div>}
    </div>
  );
}
