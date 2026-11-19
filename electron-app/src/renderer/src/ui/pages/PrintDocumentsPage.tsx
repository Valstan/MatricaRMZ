import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  PRINT_DOCUMENT_STATUS_TITLES,
  PRINT_FORM_KINDS,
  printFormKind,
  type PrintDocumentDto,
  type PrintDocumentStatus,
  type PrintTemplateRow,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { PrintDocumentFillDialog } from '../components/PrintDocumentFillDialog.js';
import { PrintDocumentPreviewDialog } from '../components/PrintDocumentPreviewDialog.js';

type Scope = 'inbox' | 'sent' | 'drafts';

const SCOPE_TITLES: Record<Scope, string> = {
  inbox: 'Пришли ко мне',
  sent: 'Отправленные',
  drafts: 'Черновики',
};

/**
 * Модуль документов: документы, созданные по печатным формам (служебная записка,
 * заявление на отпуск), и **приёмка между операторами**.
 *
 * Приёмка — явное действие получателя: «отправил документ» значит, что он у
 * получателя в «Пришли ко мне», а дальше он его принимает или отклоняет. Синхронизация
 * строк приёмку не заменяет — решение остаётся за человеком.
 */
export function PrintDocumentsPage(props: { canEdit: boolean }) {
  const { confirm } = useConfirm();
  const [scope, setScope] = useState<Scope>('inbox');
  const [rows, setRows] = useState<PrintDocumentDto[]>([]);
  const [templates, setTemplates] = useState<PrintTemplateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [filling, setFilling] = useState(false);
  const [preview, setPreview] = useState<PrintDocumentDto | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [docs, tpls] = await Promise.all([
        window.matrica.printForms.documents.list({ scope }),
        window.matrica.printForms.templates.list(),
      ]);
      setRows(docs.ok ? docs.rows : []);
      setTemplates(tpls.ok ? tpls.rows : []);
      if (!docs.ok) setStatus(`Ошибка загрузки: ${docs.error}`);
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const documentKinds = useMemo(() => PRINT_FORM_KINDS.filter((k) => k.isDocument), []);

  const decide = useCallback(
    async (doc: PrintDocumentDto, decision: 'accepted' | 'rejected') => {
      const ok = await confirm({
        title: decision === 'accepted' ? 'Принять документ?' : 'Отклонить документ?',
        detail:
          decision === 'accepted'
            ? `«${doc.title}» — принять. Документ уйдёт автору как принятый.`
            : `«${doc.title}» — отклонить. Автор увидит отказ и сможет переделать документ.`,
        confirmLabel: decision === 'accepted' ? 'Принять' : 'Отклонить',
        confirmTone: decision === 'accepted' ? 'success' : 'danger',
      });
      if (!ok) return;
      const res = await window.matrica.printForms.documents.decide({ id: doc.id, decision });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setStatus(decision === 'accepted' ? 'Документ принят.' : 'Документ отклонён.');
      void refresh();
    },
    [confirm, refresh],
  );

  const send = useCallback(
    async (doc: PrintDocumentDto) => {
      const res = await window.matrica.printForms.documents.send({
        id: doc.id,
        recipientUsername: doc.recipientUsername ?? '',
        recipientId: doc.recipientId,
      });
      if (!res.ok) {
        setStatus(`Ошибка отправки: ${res.error}`);
        return;
      }
      setStatus('Документ отправлен.');
      void refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (doc: PrintDocumentDto) => {
      const ok = await confirm({
        title: 'Удалить документ?',
        detail: `«${doc.title}» будет удалён безвозвратно.`,
        confirmLabel: 'Удалить',
        confirmTone: 'danger',
      });
      if (!ok) return;
      const res = await window.matrica.printForms.documents.delete(doc.id);
      if (!res.ok) {
        setStatus(`Ошибка удаления: ${res.error}`);
        return;
      }
      setStatus('Документ удалён.');
      void refresh();
    },
    [confirm, refresh],
  );

  return (
    <div style={{ padding: 12 }}>
      <h2 style={{ marginTop: 0 }}>Документы и заявки</h2>
      <div style={{ fontSize: 12, color: 'var(--subtle)', marginBottom: 10 }}>
        Документы создаются по печатным формам и передаются другому оператору: он видит их
        в «Пришли ко мне», открывает в программе, печатает, выводит в Word или Excel — и
        принимает или отклоняет.
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        {(Object.keys(SCOPE_TITLES) as Scope[]).map((s) => (
          <Button key={s} onClick={() => setScope(s)}>
            {SCOPE_TITLES[s]}
          </Button>
        ))}
        <div style={{ marginLeft: 'auto' }}>
          {props.canEdit ? <Button onClick={() => setFilling(true)}>+ Создать документ</Button> : null}
        </div>
      </div>

      {status ? (
        <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger, #b91c1c)' : 'var(--success, #047857)', marginBottom: 8 }}>
          {status}
        </div>
      ) : null}

      <ListCount total={rows.length} shown={rows.length} />
      <table className="list-table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <RowNumberHeaderCell />
            <th style={{ width: 300 }}>Документ</th>
            <th style={{ width: 220 }}>Вид</th>
            <th style={{ width: 180 }}>От кого / кому</th>
            <th style={{ width: 140 }}>Состояние</th>
            <th style={{ width: 300 }}>Действия</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={6} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                Загрузка…
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={6} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                {SCOPE_TITLES[scope]}: пусто.
              </td>
            </tr>
          ) : (
            rows.map((doc, i) => {
              const kind = printFormKind(doc.entityKey);
              const status_ = doc.status as PrintDocumentStatus;
              return (
                <tr key={doc.id}>
                  <RowNumberCell n={i + 1} />
                  <td>{doc.title}</td>
                  <td>{kind?.title ?? doc.entityKey}</td>
                  <td>
                    {doc.authorUsername}
                    {doc.recipientUsername ? ` → ${doc.recipientUsername}` : ''}
                  </td>
                  <td>{PRINT_DOCUMENT_STATUS_TITLES[status_] ?? doc.status}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <Button onClick={() => setPreview(doc)}>Открыть</Button>
                      {doc.status === 'sent' && scope === 'inbox' ? (
                        <>
                          <Button onClick={() => void decide(doc, 'accepted')}>Принять</Button>
                          <Button onClick={() => void decide(doc, 'rejected')}>Отклонить</Button>
                        </>
                      ) : null}
                      {doc.status === 'draft' ? (
                        <>
                          <Button onClick={() => void send(doc)}>Отправить</Button>
                          <Button onClick={() => void remove(doc)}>Удалить</Button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {filling ? (
        <PrintDocumentFillDialog
          kinds={documentKinds}
          templates={templates}
          onClose={() => setFilling(false)}
          onCreated={() => {
            setFilling(false);
            setStatus('Документ создан — черновик в разделе «Черновики».');
            void refresh();
          }}
        />
      ) : null}

      {preview ? (
        <PrintDocumentPreviewDialog document={preview} onClose={() => setPreview(null)} />
      ) : null}
    </div>
  );
}
