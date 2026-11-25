import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  applyPrintTemplate,
  parsePrintTemplateLayout,
  resolvePrintTemplate,
  type PrintTemplateLayout,
  type PrintTemplateRow,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { PrintTemplateEditorDialog } from './PrintTemplateEditorDialog.js';
import { openPrintPreview, type PrintSection } from '../utils/printPreview.js';
import { buildPrintFormsA4PreviewHtml } from '../utils/printFormsPreview.js';

/**
 * Окно печати по печатной форме: выбор шаблона, живой предпросмотр, правка формы
 * на лету.
 *
 * Что просил владелец (промты КАРМАНА #4): «выбираешь шаблон для этого дела, и
 * данные из карточки попадают в печатную форму… Пункты можно отключать и включать…
 * Вижу, что форма несовершенна, и мне нужно её изменить: кнопка сразу же переводит
 * в редактирование печатной формы. Изменил, сохранил, вернулся обратно в ту форму,
 * которую печатал, — изменения уже применены».
 *
 * Здесь всё это и происходит: шаблон выбирается сверху, предпросмотр показывает лист
 * «как на бумаге», пункты формы отключаются галочками, а «Править форму» открывает
 * редактор и возвращает сюда с уже применёнными изменениями.
 */
export function PrintFormsDialog(props: {
  title: string;
  /** Вид объекта, к которому привязаны шаблоны ('ppe_card', 'engine_card', …). */
  entityKey: string;
  /** Все блоки формы (без шаблона). Шаблон решает, что убрать. */
  buildSections: () => PrintSection[];
  extraCss?: string;
  /**
   * Запасная раскладка — когда шаблонов нет (сервер недоступен, миграция не
   * применена). Например, прежний шаблон печати СИЗ: печать не должна «потерять»
   * настройку блоков из-за недоступности сервера.
   */
  fallbackLayout?: PrintTemplateLayout;
  canEdit: boolean;
  canEditShared: boolean;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<PrintTemplateRow[]>([]);
  const [templateId, setTemplateId] = useState<string>('');
  const [layout, setLayout] = useState<PrintTemplateLayout>({});
  /** Что оператор отключил прямо сейчас — поверх шаблона (и обратно: включил). */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.matrica.printForms.templates.list({ entityKey: props.entityKey });
      const rows = res.ok ? res.rows : [];
      setTemplates(rows);
      const chosen = resolvePrintTemplate(rows);
      setTemplateId((prev) => prev || chosen?.id || '');
    } finally {
      setLoading(false);
    }
  }, [props.entityKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const template = useMemo(
    () => templates.find((t) => t.id === templateId) ?? null,
    [templates, templateId],
  );

  // Шаблон сменился — перечитываем его раскладку. Галочки оператора при этом
  // сохраняются: он отключил пункт «здесь и сейчас», а не «в этом шаблоне».
  useEffect(() => {
    if (!template) {
      setLayout(props.fallbackLayout ?? {});
      return;
    }
    setLayout(parsePrintTemplateLayout(template.layoutJson));
  }, [template, props.fallbackLayout]);

  const allSections = useMemo(() => props.buildSections(), [props]);

  const visibleSections = useMemo(() => {
    const templateSections = applyPrintTemplate(allSections, layout);
    return templateSections.filter((s) => overrides[s.id] !== false);
  }, [allSections, layout, overrides]);

  const templateDisabled = useMemo(() => {
    const disabled = new Set<string>();
    for (const s of layout.sections ?? []) {
      if (s.enabled === false) disabled.add(String(s.id));
    }
    return disabled;
  }, [layout]);

  const toggleSection = useCallback((id: string, on: boolean) => {
    setOverrides((prev) => ({ ...prev, [id]: on }));
  }, []);

  const previewHtml = useMemo(
    () =>
      buildPrintFormsA4PreviewHtml({
        sections: visibleSections,
        ...(props.extraCss ? { extraCss: props.extraCss } : {}),
        ...(layout.images?.length ? { images: layout.images } : {}),
      }),
    [visibleSections, props.extraCss, layout.images],
  );

  const doPrint = useCallback(() => {
    openPrintPreview({
      title: props.title,
      sections: visibleSections,
      printHeader: {
        title: props.title,
        hideTitle: true,
        meta: `Напечатано: ${new Date().toLocaleString('ru-RU')}`,
        ...(layout.headerNote ? { lines: [layout.headerNote] } : {}),
      },
    });
  }, [props.title, visibleSections, layout.headerNote]);

  const afterTemplateSaved = useCallback(async () => {
    setEditing(false);
    setStatus('Форма сохранена — изменения применены.');
    await load();
  }, [load]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: 'var(--surface, #fff)',
          borderRadius: 8,
          padding: 14,
          width: 'min(1080px, 96vw)',
          height: 'min(88vh, 900px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <strong style={{ marginRight: 4 }}>Печать:</strong>
          <select
            value={templateId}
            onChange={(e) => {
              setTemplateId(e.target.value);
              setOverrides({});
            }}
            style={{ padding: '4px 8px', minWidth: 220 }}
          >
            <option value="">Без шаблона — все пункты</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.ownerId === 'shared' ? 'общий' : 'личный'})
              </option>
            ))}
          </select>
          {props.canEdit ? (
            <Button
              onClick={() => setEditing(true)}
              title="Править печатную форму — изменения применятся сразу"
              disabled={!template}
            >
              Править форму
            </Button>
          ) : null}
          <Button onClick={props.onClose}>Закрыть</Button>
          <Button onClick={doPrint} disabled={loading}>
            Печать / PDF
          </Button>
        </div>

        {status ? <div style={{ fontSize: 12, color: 'var(--success, #047857)' }}>{status}</div> : null}

        <div style={{ display: 'flex', gap: 12, flex: '1 1 auto', minHeight: 0 }}>
          <div style={{ width: 260, overflow: 'auto', flex: '0 0 auto' }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Пункты формы</div>
            {allSections.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--subtle)' }}>У формы нет пунктов.</div>
            ) : (
              allSections.map((s) => {
                const on = overrides[s.id] ?? !templateDisabled.has(s.id);
                const offByTemplate = templateDisabled.has(s.id) && overrides[s.id] !== true;
                return (
                  <label
                    key={s.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 4 }}
                    title={offByTemplate ? 'Снят шаблоном — можно включить на лету' : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => toggleSection(s.id, e.target.checked)}
                    />
                    {s.title}
                    {offByTemplate ? <span style={{ color: 'var(--subtle)', fontSize: 11 }}>(снят шаблоном)</span> : null}
                  </label>
                );
              })
            )}
            {layout.footerNote ? (
              <div style={{ marginTop: 10, fontSize: 11, color: 'var(--subtle)' }}>
                Подвал: {layout.footerNote}
              </div>
            ) : null}
          </div>

          <iframe
            title="Предпросмотр печатной формы"
            srcDoc={previewHtml}
            style={{ flex: '1 1 auto', border: '1px solid var(--border, #e5e7eb)', borderRadius: 6, background: '#e7e9ef' }}
          />
        </div>
      </div>

      {editing && template ? (
        <PrintTemplateEditorDialog
          template={template}
          canEdit={props.canEdit}
          canEditShared={props.canEditShared}
          onClose={() => setEditing(false)}
          onSaved={() => void afterTemplateSaved()}
        />
      ) : null}
    </div>
  );
}
