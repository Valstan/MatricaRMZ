import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  SCAN_MODE_CHOICES,
  SCAN_MODE_LABELS,
  SCAN_RESOLUTION_CHOICES,
  SCAN_SIZE_CHOICES,
  SCAN_SIZE_LABELS,
  buildScanFileName,
  describeScanSettings,
  resolveScanResolution,
  scanModeNotice,
  scanResolutionNotice,
  type ScanActual,
  type ScanCapabilities,
  type ScanMode,
  type ScanProgressEvent,
  type ScanSettings,
  type ScanSize,
} from '@matricarmz/shared';

import { Button } from './Button.js';

// Окно скана с настройками (промт КАРМАНА #178).
//
// Раньше окно говорило «положите документ в сканер и нажмите „Сканировать“» и
// содержало одну кнопку. Теперь оператор перед съёмом выбирает РЕЖИМ, РАЗРЕШЕНИЕ и
// РАЗМЕР листа, видит полосу прогресса по этапам, правит имя файла прямо в окне и
// внизу жмёт «Сохранить скан в программе».
//
// Две фазы, и они явные:
//   1) съём — оператор выбирает настройки и жмёт «Сканировать», программа идёт по
//      этапам «ищем сканер → снимаем → сохраняем»;
//   2) имя — кадр снят, окно показывает имя файла (предложенное программой и
//      редактируемое) и кнопку «Сохранить скан в программе».
//
// Правда вместо обещаний: под настройками написано, что получится на самом деле
// (режим, разрешение, размер и кадр в пикселях). Если сканер не умеет 300 dpi или
// цвет — подпись скажет об этом словами, а не спрячет.

/** Чип-переключатель настроек: выбранный — тёмный, остальные — светлые. */
function ChoiceChip(props: { active: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.title}
      style={{
        borderRadius: 10,
        border: '1px solid #cbd5e1',
        background: props.active ? '#1d4ed8' : '#fff',
        color: props.active ? '#fff' : '#0f172a',
        padding: '7px 12px',
        fontSize: 13,
        cursor: 'pointer',
      }}
    >
      {props.children}
    </button>
  );
}

/**
 * Ластик «Стереть резинку» — тот же вид, что в выпадающих списках программы
 * (красно-белая стирательная резинка вместо крестика). Здесь она очищает поле
 * имени файла.
 */
function EraserButton(props: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      title="Стереть резинку"
      aria-label="Стереть резинку"
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 40,
        height: 40,
        borderRadius: 10,
        border: '1px solid #cbd5e1',
        background: '#f8fafc',
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.5 : 1,
      }}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <g transform="rotate(-45 12 12)">
          <rect x="3" y="9" width="18" height="8" rx="1.6" fill="#ffffff" stroke="#9f1239" strokeWidth="1.5" />
          <path
            d="M3 10.6 a1.6 1.6 0 0 1 1.6 -1.6 H10 v8 H4.6 A1.6 1.6 0 0 1 3 15.4 Z"
            fill="#e11d48"
            stroke="#9f1239"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </g>
      </svg>
    </button>
  );
}

export function ScanSettingsDialog(props: {
  open: boolean;
  /** Название карточки объекта — по нему программа предлагает имя файла. */
  objectLabel: string;
  /** Окно закрыли без сохранения. */
  onCancel: () => void;
  /** Кадр уехал в объект: дальше его грузит панель (тем же путём, что файл с диска). */
  onSaved: (file: { path: string; fileName: string }) => void;
  /** Отказ называем словами оператора. */
  onError: (message: string) => void;
}) {
  const [settings, setSettings] = useState<ScanSettings>({ resolution: 'max', mode: 'color', size: 'max' });
  const [capabilities, setCapabilities] = useState<ScanCapabilities | null>(null);
  const [capabilitiesError, setCapabilitiesError] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [progress, setProgress] = useState<ScanProgressEvent | null>(null);
  /** Снятый кадр: во ВРЕМЕННОЙ папке, в объект ещё не попал. */
  const [captured, setCaptured] = useState<{ path: string; fileName: string; actual: ScanActual | null } | null>(null);
  const [fileName, setFileName] = useState('');
  /** Трогал ли оператор поле имени: раз трогал — программа своё имя не подставляет. */
  const nameTouched = useRef(false);
  const [nameTouchedState, setNameTouchedState] = useState(false);

  // Что предложить: имя по правилу «карточка + скан + время».
  const proposedName = useMemo(
    () => buildScanFileName(props.objectLabel, new Date()),
    // Имя пересчитывается при открытии окна, а не на каждый рендер.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.objectLabel, props.open],
  );

  // Что умеет сканер: спрашиваем один раз при открытии окна, чтобы подпись под
  // настройками говорила правду («максимум сканера: 200 dpi»).
  useEffect(() => {
    if (!props.open) return;
    let alive = true;
    setCapabilitiesError('');
    void window.matrica.scan
      .capabilities()
      .then((res) => {
        if (!alive) return;
        if (!res.ok) {
          setCapabilitiesError(res.error);
          setCapabilities(null);
          return;
        }
        setCapabilities(res.capabilities);
      })
      .catch((e) => {
        if (!alive) return;
        setCapabilitiesError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [props.open]);

  // Имя предлагается при открытии окна и обновляется после съёма, если оператор
  // его не трогал: штамп времени должен быть от момента съёма.
  useEffect(() => {
    if (!props.open) return;
    nameTouched.current = false;
    setNameTouchedState(false);
    setFileName(proposedName);
  }, [props.open, proposedName]);

  const maxResolution = capabilities?.maxResolution ?? 0;
  /** Отдельный выбор «максимум сканера» нужен, только если он отличается от 150 и 300. */
  const maxChoiceVisible = maxResolution > 0 && maxResolution !== 150 && maxResolution !== 300;

  /** Разрешение, которое получится на самом деле (сканер может не уметь запрошенное). */
  const plannedResolution = useMemo(() => {
    const supported = capabilities?.supportedResolutions ?? [];
    if (settings.resolution === 'max') return maxResolution > 0 ? maxResolution : 300;
    if (supported.length === 0) return settings.resolution;
    return resolveScanResolution(settings.resolution, supported);
  }, [settings.resolution, maxResolution, capabilities]);

  const plannedCaption = useMemo(
    () =>
      describeScanSettings({
        mode: settings.mode,
        resolution: plannedResolution,
        size: settings.size,
      }),
    [settings.mode, settings.size, plannedResolution],
  );

  /** Подпись ПОСЛЕ съёма — по тому, что сканер отдал на самом деле. */
  const actualCaption = useMemo(() => {
    if (!captured?.actual) return '';
    const a = captured.actual;
    return describeScanSettings({
      mode: a.mode,
      resolution: a.resolution,
      size: a.size,
      framePixels: { width: a.width, height: a.height },
    });
  }, [captured]);

  const handleProgress = useCallback((event: ScanProgressEvent) => {
    setProgress(event);
  }, []);

  const runCapture = useCallback(async () => {
    if (capturing) return;
    setCapturing(true);
    setProgress(null);
    const unsubscribe = window.matrica.scan.onProgress(handleProgress);
    try {
      const shot = await window.matrica.scan.document({ label: props.objectLabel, settings });
      if (!shot.ok) {
        setProgress(null);
        props.onError(shot.error);
        return;
      }
      // Полоса доходит до конца — окно переходит к имени файла.
      setProgress({ stage: 'saving', label: 'Кадр снят', done: 3, total: 3 });
      setCaptured({ path: shot.path, fileName: shot.fileName, actual: shot.actual ?? null });
      // Предложенное программой имя остаётся, если оператор его не трогал.
      if (!nameTouched.current) {
        setFileName(shot.fileName);
        setNameTouchedState(false);
      }
    } catch (e) {
      setProgress(null);
      props.onError(e instanceof Error ? e.message : String(e));
    } finally {
      unsubscribe();
      setCapturing(false);
    }
  }, [capturing, handleProgress, props, settings]);

  const saveScan = useCallback(async () => {
    if (!captured) return;
    const name = fileName.trim();
    if (!name) {
      props.onError('Введите имя файла — без него скан не положить в объект.');
      return;
    }
    const placed = await window.matrica.scan.place({
      path: captured.path,
      fileName: name,
      label: props.objectLabel,
    });
    if (!placed.ok) {
      props.onError(`Скан не попал в объект: ${placed.error}`);
      return;
    }
    props.onSaved({ path: placed.path, fileName: placed.fileName });
  }, [captured, fileName, props]);

  const cancel = useCallback(async () => {
    // Кадр, который оператор не сохранил, убираем — иначе он лежит мусором.
    if (captured) {
      await window.matrica.scan.discard({ path: captured.path }).catch(() => undefined);
    }
    props.onCancel();
  }, [captured, props]);

  if (!props.open) return null;

  const nameEditable = !!captured;
  const progressPercent = progress ? Math.min(100, Math.round((progress.done / Math.max(1, progress.total)) * 100)) : 0;

  return (
    <div
      data-scan-settings
      style={{ marginTop: 10, padding: 12, border: '1px solid #e5e7eb', borderRadius: 12, background: '#f8fafc' }}
    >
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Сканирование документа</div>
      <div style={{ fontSize: 13, color: '#334155' }}>
        Положите документ в сканер и нажмите «Сканировать». Настройки ниже можно поменять перед съёмом.
      </div>

      {/* Разрешение */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, color: '#475569', marginBottom: 4 }}>Разрешение</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {SCAN_RESOLUTION_CHOICES.filter((choice) => choice !== 'max' || maxChoiceVisible).map((choice) => (
            <ChoiceChip
              key={String(choice)}
              active={settings.resolution === choice}
              onClick={() => setSettings((prev) => ({ ...prev, resolution: choice }))}
              {...(choice === 'max' ? { title: `Максимум, который умеет сканер: ${maxResolution} dpi` } : {})}
            >
              {choice === 'max' ? `Максимум (${maxResolution} dpi)` : `${choice} dpi`}
            </ChoiceChip>
          ))}
        </div>
      </div>

      {/* Режим */}
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 12, color: '#475569', marginBottom: 4 }}>Режим</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {SCAN_MODE_CHOICES.map((mode: ScanMode) => (
            <ChoiceChip
              key={mode}
              active={settings.mode === mode}
              onClick={() => setSettings((prev) => ({ ...prev, mode }))}
            >
              {SCAN_MODE_LABELS[mode]}
            </ChoiceChip>
          ))}
        </div>
      </div>

      {/* Размер */}
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 12, color: '#475569', marginBottom: 4 }}>Размер</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {SCAN_SIZE_CHOICES.map((size: ScanSize) => (
            <ChoiceChip
              key={size}
              active={settings.size === size}
              onClick={() => setSettings((prev) => ({ ...prev, size }))}
              {...(size === 'max' ? { title: 'Скан целиком, сколько сканер умеет' } : {})}
            >
              {SCAN_SIZE_LABELS[size]}
            </ChoiceChip>
          ))}
        </div>
      </div>

      {/* Подпись под настройками: что получится на самом деле. */}
      <div style={{ marginTop: 8, fontSize: 12, color: '#334155' }}>
        {captured && actualCaption ? actualCaption : plannedCaption}
      </div>
      {captured && captured.actual ? (
        <div style={{ marginTop: 4, fontSize: 12, color: '#b45309' }}>
          {scanResolutionNotice(
            settings.resolution === 'max' ? captured.actual.resolution : Number(settings.resolution),
            captured.actual.resolution,
          )}
          {scanModeNotice(settings.mode, captured.actual.mode)}
        </div>
      ) : (
        <div style={{ marginTop: 4, fontSize: 12, color: '#64748b' }}>
          {capabilitiesError
            ? `Сканер не ответил: ${capabilitiesError}`
            : scanResolutionNotice(
                settings.resolution === 'max' ? plannedResolution : Number(settings.resolution),
                plannedResolution,
              )}
        </div>
      )}

      {/* Кнопка съёма и полоса прогресса. */}
      <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button disabled={capturing || !!captured} onClick={() => void runCapture()}>
          {capturing ? 'Сканируем...' : 'Сканировать'}
        </Button>
      </div>

      {progress ? (
        <div style={{ marginTop: 8 }} data-scan-progress>
          <div style={{ fontSize: 12, color: '#475569', marginBottom: 4 }}>{progress.label}</div>
          <div
            style={{
              height: 8,
              borderRadius: 4,
              background: '#e2e8f0',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${progressPercent}%`,
                background: '#2563eb',
                transition: 'width .2s ease-out',
              }}
            />
          </div>
        </div>
      ) : null}

      {/* Имя файла — правится прямо здесь. */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, color: '#475569', marginBottom: 4 }}>Имя файла</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={fileName}
            onChange={(e) => {
              nameTouched.current = true;
              setNameTouchedState(true);
              setFileName(e.target.value);
            }}
            placeholder="Имя файла"
            style={{
              flex: 1,
              minWidth: 200,
              border: '1px solid #cbd5e1',
              borderRadius: 10,
              padding: '9px 11px',
              fontSize: 14,
              background: nameEditable ? '#fff' : '#f1f5f9',
            }}
          />
          <EraserButton
            disabled={!fileName}
            onClick={() => {
              nameTouched.current = true;
              setNameTouchedState(true);
              setFileName('');
            }}
          />
        </div>
        <div style={{ marginTop: 4, fontSize: 11, color: '#64748b' }}>
          Программа назвала файл по правилу «карточка + скан + время». Напишите своё — можно стереть ластиком.
          {nameTouchedState ? ' Ваше имя останется как есть.' : ''}
        </div>
      </div>

      {/* Внизу окна — сохранение скана в программе. */}
      <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button disabled={!captured || !fileName.trim() || capturing} onClick={() => void saveScan()}>
          Сохранить скан в программе
        </Button>
        <Button variant="ghost" disabled={capturing} onClick={() => void cancel()}>
          Отмена
        </Button>
      </div>
    </div>
  );
}
