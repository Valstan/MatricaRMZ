import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ENGINE_CARD_TRANSFER_TARGETS,
  buildEngineCardTransferPreview,
  engineCardMissingCharacteristics,
  parseTransferDate,
  suggestTransferTargetCode,
  type EngineCardTransferTarget,
  type FileSearchMatch,
  type FileSearchResult,
  type FileSearchSource,
  type FileSearchWordMatch,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SectionCard } from '../components/SectionCard.js';

type EngineLookup = {
  id: string;
  engineNumber: string;
  internalNumberFull: string;
  rmzCode: string;
  matchedBy: 'engine_number' | 'internal_number';
} | null;

type Pending = { value: string; label: string };

const KIND_RU: Record<FileSearchSource['kind'], string> = {
  excel: 'Excel',
  word: 'Word',
  text: 'Текст',
};

function cardValueText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  const text = String(value).trim();
  return text ? text : null;
}

function formatMs(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Даты в карточке лежат миллисекундами — оператору показываем датой. */
function displayValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 1_000_000_000_000) return formatMs(value);
  return cardValueText(value);
}

function matchKey(match: FileSearchMatch): string {
  return match.kind === 'excel'
    ? `${match.sourceId}:x:${match.sheetName}:${match.rowNumber}`
    : `${match.sourceId}:p:${match.paragraphIndex}`;
}

/**
 * Модуль «Поиск по файлам» (промт КАРМАНА #32).
 *
 * Три блока сверху вниз: файлы-источники → строка поиска → результаты.
 * Результаты — две колонки: слева что нашлось в файлах, справа карточка
 * двигателя из базы (по ТОЧНОМУ совпадению номера) и перенос найденного в её поля.
 *
 * Файлы читает главный процесс: в renderer нет ни `exceljs`, ни `jszip`, ни
 * доступа к диску — только результаты поиска.
 */
export function FileSearchPage(props: { canEdit?: boolean }) {
  const canEdit = props.canEdit ?? true;
  const [sources, setSources] = useState<FileSearchSource[]>([]);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<FileSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const [lookup, setLookup] = useState<{ engine: EngineLookup; note: string | null } | null>(null);
  const [card, setCard] = useState<Record<string, unknown> | null>(null);
  const [defs, setDefs] = useState<{ code: string; name: string }[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [targetCode, setTargetCode] = useState<string>(ENGINE_CARD_TRANSFER_TARGETS[0]?.code ?? '');
  const [extraLines, setExtraLines] = useState<Record<string, string[]>>({});

  useEffect(() => {
    void (async () => {
      const res = await window.matrica.fileSearch.sources.get();
      if (res.ok) setSources(res.sources);
    })();
  }, []);

  const persistSources = useCallback(async (next: FileSearchSource[]) => {
    setSources(next);
    const res = await window.matrica.fileSearch.sources.set({ sources: next });
    if (!res.ok) setStatus(`Не удалось запомнить список файлов: ${res.error}`);
  }, []);

  const addFiles = useCallback(async () => {
    const picked = await window.matrica.fileSearch.pick();
    if (!picked.ok) return;
    const merged = new Map(sources.map((s) => [s.id, s]));
    for (const source of picked.sources) merged.set(source.id, source);
    await persistSources([...merged.values()]);
    if (picked.skipped.length > 0) {
      setStatus(`Не взяты файлы: ${picked.skipped.map((s) => s.split(':')[0]).join(', ')} — формат не поддерживается.`);
    } else {
      setStatus('');
    }
  }, [persistSources, sources]);

  const reselect = useCallback(
    async (sourceId: string) => {
      await persistSources(sources.filter((s) => s.id !== sourceId));
      await addFiles();
    },
    [addFiles, persistSources, sources],
  );

  const loadEngine = useCallback(async (q: string) => {
    const found = await window.matrica.engines.findExactByNumber({ query: q });
    if (!found.ok) {
      setLookup({ engine: null, note: found.error });
      setCard(null);
      return;
    }
    setLookup({ engine: found.engine, note: found.note });
    if (!found.engine) {
      setCard(null);
      setDraft({});
      return;
    }
    const details = await window.matrica.engines.get(found.engine.id);
    const attrs = details.attributes ?? {};
    setCard(attrs);
    setDraft(
      Object.fromEntries(
        ENGINE_CARD_TRANSFER_TARGETS.map((target) => [target.code, cardValueText(attrs[target.code]) ?? '']),
      ),
    );
    const characteristics = await window.matrica.engines.characteristics();
    if (characteristics.ok) setDefs(characteristics.defs);
  }, []);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setStatus('Введите, что ищем — например номер двигателя.');
      return;
    }
    if (sources.length === 0) {
      setStatus('Сначала добавьте файлы, в которых ищем.');
      return;
    }
    setBusy(true);
    try {
      const res = await window.matrica.fileSearch.search({ sources, query: q });
      if (!res.ok) {
        setStatus(`Ошибка поиска: ${res.error}`);
        return;
      }
      setResult(res.result);
      setStatus('');
      await loadEngine(q);
    } finally {
      setBusy(false);
    }
  }, [loadEngine, query, sources]);

  const target = useMemo<EngineCardTransferTarget>(
    () => ENGINE_CARD_TRANSFER_TARGETS.find((t) => t.code === targetCode) ?? ENGINE_CARD_TRANSFER_TARGETS[0]!,
    [targetCode],
  );

  const preview = useMemo(() => {
    if (!pending || !card) return null;
    return buildEngineCardTransferPreview({
      card,
      target,
      candidateValue: pending.value,
      candidateLabel: pending.label,
    });
  }, [card, pending, target]);

  const missing = useMemo(() => {
    if (!card) return [];
    return engineCardMissingCharacteristics({
      card,
      known: defs.map((d) => ({ code: d.code, label: d.name })),
    });
  }, [card, defs]);

  const filled = useMemo(() => {
    if (!card) return [];
    return defs
      .map((d) => ({ code: d.code, label: d.name, value: displayValue(card[d.code]) }))
      .filter((row) => row.value != null);
  }, [card, defs]);

  async function copyValue(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus('Значение скопировано в буфер обмена.');
    } catch {
      setStatus('Не удалось скопировать значение.');
    }
  }

  function chooseTransfer(value: string, label: string) {
    const suggested = suggestTransferTargetCode(label);
    const found = ENGINE_CARD_TRANSFER_TARGETS.find((t) => t.code === suggested);
    setPending({ value, label });
    setTargetCode(found?.code ?? targetCode);
  }

  function applyAutoTransfer() {
    if (!preview?.compatible) return;
    setDraft((prev) => ({ ...prev, [preview.target.code]: preview.candidateValue }));
    setStatus(`Значение подставлено в поле «${preview.target.label}». Запишите карточку кнопкой ниже.`);
  }

  function applyManualTransfer() {
    if (!pending) return;
    setDraft((prev) => ({ ...prev, [target.code]: pending.value }));
    setStatus(`Значение вставлено в поле «${target.label}» как есть — проверьте формат и запишите карточку.`);
  }

  async function saveCard() {
    if (!lookup?.engine || !card) return;
    const fields: Record<string, unknown> = {};
    for (const field of ENGINE_CARD_TRANSFER_TARGETS) {
      const raw = String(draft[field.code] ?? '').trim();
      if (!raw) continue;
      if (cardValueText(card[field.code]) === raw) continue;
      if (field.kind === 'date') {
        const ts = parseTransferDate(raw);
        if (ts == null) {
          setStatus(`«${field.label}»: «${raw}» — это не дата. Формат: ДД.ММ.ГГГГ.`);
          return;
        }
        fields[field.code] = ts;
      } else if (field.kind === 'number') {
        const n = Number(raw.replace(',', '.'));
        if (!Number.isFinite(n)) {
          setStatus(`«${field.label}»: «${raw}» — это не число.`);
          return;
        }
        fields[field.code] = n;
      } else {
        fields[field.code] = raw;
      }
    }
    if (Object.keys(fields).length === 0) {
      setStatus('Менять нечего — в полях те же значения, что и в карточке.');
      return;
    }
    const res = await window.matrica.engines.card.save({ id: lookup.engine.id, fields });
    if (!res.ok) {
      setStatus(`Не записалось: ${res.error ?? 'неизвестная причина'}`);
      return;
    }
    setStatus('Записано в карточку двигателя.');
    await loadEngine(query.trim());
  }

  async function showBelow(match: FileSearchWordMatch) {
    const source = sources.find((s) => s.id === match.sourceId);
    if (!source) return;
    const res = await window.matrica.fileSearch.context({
      source,
      paragraphIndex: match.paragraphIndex,
      count: 10,
    });
    if (!res.ok) {
      setStatus(`Не удалось показать строки ниже: ${res.error}`);
      return;
    }
    setExtraLines((prev) => ({ ...prev, [matchKey(match)]: res.paragraphs }));
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SectionCard title="Файлы для поиска">
        <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
          Файлы читаются только на чтение — изменить их из модуля нельзя. Перед каждым поиском файлы перечитываются,
          поэтому ищется свежая версия. Пути запоминаются на этом компьютере.
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button variant="primary" onClick={() => void addFiles()} disabled={busy}>
            Добавить файлы
          </Button>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            {sources.length === 0 ? 'Файлы не выбраны' : `Файлов: ${sources.length}`}
          </span>
        </div>
        {sources.length > 0 ? (
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Файл</th>
                <th>Путь</th>
                <th>Тип</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td>{source.name}</td>
                  <td style={{ color: 'var(--muted)', fontSize: 12, wordBreak: 'break-all' }}>{source.path}</td>
                  <td>{KIND_RU[source.kind]}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Button size="sm" variant="outline" onClick={() => void reselect(source.id)}>
                      Перевыбрать
                    </Button>{' '}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void persistSources(sources.filter((s) => s.id !== source.id))}
                    >
                      Убрать
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </SectionCard>

      <SectionCard title="Что ищем">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
            }}
            placeholder="Например: 41/26"
            style={{ flex: 1, minWidth: 220 }}
          />
          <Button variant="primary" onClick={() => void runSearch()} disabled={busy}>
            Искать
          </Button>
        </div>
        {status ? (
          <div style={{ color: status.startsWith('Не ') || status.startsWith('Ошибка') ? 'var(--danger, #b00)' : 'var(--muted)', marginTop: 8 }}>
            {status}
          </div>
        ) : null}
      </SectionCard>

      {result && result.unreadable.length > 0 ? (
        <SectionCard title="Файлы, которые не прочитались">
          <div style={{ fontSize: 13 }}>
            Поиск по остальным файлам продолжен. Эти файлы надо открыть заново:
          </div>
          {result.unreadable.map((item) => (
            <div key={item.path} style={{ marginTop: 8, fontSize: 13 }}>
              <div style={{ color: 'var(--danger, #b00)' }}>{item.path}</div>
              <div style={{ color: 'var(--muted)', fontSize: 12 }}>{item.reason}</div>
              <Button
                size="sm"
                variant="outline"
                style={{ marginTop: 4 }}
                onClick={() => {
                  const source = sources.find((s) => s.path === item.path);
                  if (source) void reselect(source.id);
                }}
              >
                Открыть заново
              </Button>
            </div>
          ))}
        </SectionCard>
      ) : null}

      {result && result.notes.length > 0 ? (
        <SectionCard title="Замечания к прочитанному">
          {result.notes.map((note) => (
            <div key={note} style={{ fontSize: 13, color: 'var(--muted)' }}>
              {note}
            </div>
          ))}
        </SectionCard>
      ) : null}

      {result ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)', gap: 16, alignItems: 'start' }}>
          <SectionCard title={`Что нашлось в файлах (${result.matches.length})`}>
            {result.matches.length === 0 ? (
              <div style={{ color: 'var(--muted)' }}>По запросу «{result.query}» в выбранных файлах ничего не нашлось.</div>
            ) : (
              result.matches.map((match) => {
                if (match.kind === 'excel') {
                  return (
                    <div key={matchKey(match)} style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
                        {match.sourceName} · лист «{match.sheetName}» · строка {match.rowNumber}
                      </div>
                      <div style={{ overflowX: 'auto' }}>
                        <table className="table" style={{ width: '100%' }}>
                          <thead>
                            <tr>
                              {match.headers.map((header, i) => (
                                <th key={`${header}-${i}`}>{header || `Столбец ${i + 1}`}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              {match.values.map((value, i) => (
                                <td key={`${value}-${i}`}>
                                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                    <span style={{ wordBreak: 'break-word' }}>{value || '—'}</span>
                                    <Button size="sm" variant="outline" onClick={() => void copyValue(value)}>
                                      Копировать
                                    </Button>
                                    {value ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => chooseTransfer(value, match.headers[i] || `Столбец ${i + 1}`)}
                                      >
                                        В карточку
                                      </Button>
                                    ) : null}
                                  </div>
                                </td>
                              ))}
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                }
                const lines = extraLines[matchKey(match)];
                return (
                  <div key={matchKey(match)} style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
                      {match.sourceName} · {match.kind === 'word' ? 'документ Word' : 'текстовый файл'} · абзац{' '}
                      {match.paragraphIndex + 1}
                    </div>
                    <div style={{ border: '1px solid var(--input-border)', borderRadius: 'var(--ui-radius-sm)', padding: 8 }}>
                      {match.text}
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                      <Button size="sm" variant="outline" onClick={() => void copyValue(match.text)}>
                        Копировать
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => chooseTransfer(match.text, 'Найденный текст')}>
                        В карточку
                      </Button>
                      {match.hasMoreBelow && !lines ? (
                        <Button size="sm" variant="outline" onClick={() => void showBelow(match)}>
                          Показать строки ниже
                        </Button>
                      ) : null}
                    </div>
                    {lines ? (
                      <div style={{ marginTop: 6, borderLeft: '2px solid var(--input-border)', paddingLeft: 8 }}>
                        {lines.map((line, i) => (
                          <div key={`${line}-${i}`} style={{ fontSize: 13, color: 'var(--muted)' }}>
                            {line}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </SectionCard>

          <SectionCard title="Карточка двигателя из базы">
            {!lookup ? (
              <div style={{ color: 'var(--muted)' }}>Запустите поиск — покажем карточку двигателя с таким же номером.</div>
            ) : !lookup.engine ? (
              <div style={{ fontSize: 13 }}>
                <div>В базе нет карточки с номером «{result?.query ?? query}».</div>
                {lookup.note ? <div style={{ color: 'var(--muted)', marginTop: 6 }}>{lookup.note}</div> : null}
              </div>
            ) : (
              <>
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  <strong>{lookup.engine.engineNumber || 'без номера'}</strong>
                  {lookup.engine.internalNumberFull ? ` · внутренний ${lookup.engine.internalNumberFull}` : ''}
                  {lookup.engine.rmzCode ? ` · ${lookup.engine.rmzCode}` : ''}
                </div>

                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>Заполненные характеристики</div>
                {filled.length === 0 ? (
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>В карточке пока ничего не заполнено.</div>
                ) : (
                  <table className="table" style={{ width: '100%' }}>
                    <tbody>
                      {filled.map((row) => (
                        <tr key={row.code}>
                          <td style={{ color: 'var(--muted)', fontSize: 12, width: '45%' }}>{row.label}</td>
                          <td>{row.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <div style={{ fontSize: 12, color: 'var(--muted)', margin: '10px 0 4px' }}>
                  Чего в карточке нет ({missing.length})
                </div>
                {missing.length === 0 ? (
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>Все известные характеристики заполнены.</div>
                ) : (
                  <div style={{ fontSize: 13 }}>{missing.map((m) => m.label).join(', ')}</div>
                )}

                <div style={{ fontSize: 12, color: 'var(--muted)', margin: '14px 0 4px' }}>Перенос из файла</div>
                {pending ? (
                  <div style={{ border: '1px solid var(--input-border)', borderRadius: 'var(--ui-radius-sm)', padding: 8 }}>
                    <div style={{ fontSize: 13 }}>
                      <strong>Что будет скопировано → куда:</strong> «{pending.label}» → «{target.label}»
                    </div>
                    <div style={{ fontSize: 13, marginTop: 4, wordBreak: 'break-word' }}>Значение: {pending.value}</div>
                    <label style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
                      Поле карточки
                      <select
                        value={target.code}
                        onChange={(e) => setTargetCode(e.target.value)}
                        style={{ display: 'block', width: '100%', marginTop: 2 }}
                      >
                        {ENGINE_CARD_TRANSFER_TARGETS.map((field) => (
                          <option key={field.code} value={field.code}>
                            {field.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {preview?.compatible ? (
                      <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>
                        Тип совпадает, поле свободно — можно переносить.
                      </div>
                    ) : (
                      <div style={{ color: 'var(--danger, #b00)', fontSize: 12, marginTop: 6 }}>
                        {preview?.reason ?? 'Перенос невозможен'}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      <Button size="sm" variant="primary" disabled={!preview?.compatible} onClick={applyAutoTransfer}>
                        Перенести
                      </Button>
                      <Button size="sm" variant="outline" onClick={applyManualTransfer}>
                        Вставить вручную
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                    Нажмите «В карточку» у найденного значения — покажем, что и куда переносится.
                  </div>
                )}

                <div style={{ fontSize: 12, color: 'var(--muted)', margin: '14px 0 4px' }}>Поля карточки</div>
                <table className="table" style={{ width: '100%' }}>
                  <tbody>
                    {ENGINE_CARD_TRANSFER_TARGETS.map((field) => (
                      <tr key={field.code}>
                        <td style={{ color: 'var(--muted)', fontSize: 12, width: '45%' }}>{field.label}</td>
                        <td>
                          <Input
                            value={draft[field.code] ?? ''}
                            disabled={!canEdit}
                            onChange={(e) => setDraft((prev) => ({ ...prev, [field.code]: e.target.value }))}
                            placeholder={cardValueText(card?.[field.code]) ?? 'пусто'}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {canEdit ? (
                  <Button
                    variant="primary"
                    style={{ marginTop: 10 }}
                    onClick={() => void saveCard()}
                    disabled={busy || !lookup.engine}
                  >
                    Скопировать данные в карточку двигателя
                  </Button>
                ) : (
                  <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
                    Запись в карточку доступна с правом правки двигателей.
                  </div>
                )}
              </>
            )}
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}
