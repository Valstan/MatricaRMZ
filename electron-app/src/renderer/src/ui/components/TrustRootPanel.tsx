import React, { useState } from 'react';

import { adminInstructions, planTrustRootSteps, trustRootLegacyNote, trustRootSummary, type TrustRootStatus } from '@matricarmz/shared';

import { Button } from './Button.js';

/**
 * «Доверие и подпись» — состояние корня Матрицы на этой машине и что с ним делать (ADR-0003).
 *
 * Панель одна на два места: и в окне обслуживания («Скрипты обслуживания»), и в подсказке,
 * которая всплывает при первом запуске. Дублировать тексты нельзя — они берутся из домена
 * (`shared/src/domain/trustRoot.ts`), иначе подсказка в двух местах разойдётся.
 *
 * Кнопки делятся на две группы по праву:
 *  - «поставить в моё хранилище» — программа делает сама, прав администратора не нужно;
 *  - «на всю машину» — нужен администратор, Windows спросит права (UAC).
 * Ни одну из них нельзя спрятать: без второй Касперский по подписи не доверяет, и оператор
 * должен видеть это как один шаг, а не как «всё сделано».
 */
export function TrustRootPanel(props: {
  status: TrustRootStatus | null;
  busy?: boolean;
  onInstallUser?: () => void;
  onInstallMachine?: () => void;
  onRefresh?: () => void;
  /** Показать инструкцию администратору сразу (в подсказке при старте — да). */
  adminOpenByDefault?: boolean;
}) {
  const [adminOpen, setAdminOpen] = useState(Boolean(props.adminOpenByDefault));
  const [copied, setCopied] = useState(false);

  const status = props.status;
  const steps = status ? planTrustRootSteps(status) : [];
  const instructions = status ? adminInstructions(status) : [];

  const copyInstructions = async () => {
    const text = instructions.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Буфер обмена может быть недоступен — тогда текст остаётся на экране, его можно выделить руками.
      setCopied(false);
    }
  };

  const machineTrusted = status?.machineTrusted === true;
  const userTrusted = status?.userTrusted === true;

  return (
    <div data-trust-root-panel style={{ display: 'grid', gap: 10 }}>
      <div style={{ fontWeight: 700, fontSize: 15 }}>Доверие и подпись</div>
      <div style={{ color: 'var(--subtle)', fontSize: 13, marginTop: -6 }}>
        Программа подписана своим ключом. Касперский не трогает подписанное, когда корень стоит в
        машинном хранилище сертификатов и включён пункт «Доверенное системное хранилище
        сертификатов».
      </div>

      {status ? (
        <div
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '8px 10px',
            display: 'grid',
            gap: 4,
          }}
        >
          <div style={{ fontWeight: 600 }}>{trustRootSummary(status)}</div>
          <div data-trust-root-store="machine" style={{ fontSize: 13, color: 'var(--subtle)' }}>
            Корень в машинном хранилище (его видит Касперский):{' '}
            {/* Цвет текста — НЕ var(--tone-*-text): эти переменные белые под цветной фон
                кнопки, а здесь текст лежит на поверхности окна, и в светлой теме он был
                белым по белому — значение не читалось. */}
            <b style={{ color: machineTrusted ? 'inherit' : 'var(--danger)' }}>
              {machineTrusted ? 'установлен' : 'не установлен'}
            </b>
          </div>
          <div data-trust-root-store="user" style={{ fontSize: 13, color: 'var(--subtle)' }}>
            Корень в вашем хранилище (этого хватает Windows для подписи):{' '}
            <b style={{ color: userTrusted ? 'inherit' : 'var(--danger)' }}>
              {userTrusted ? 'установлен' : 'не установлен'}
            </b>
          </div>
          <div data-trust-root-signature style={{ fontSize: 13, color: 'var(--subtle)' }}>
            Подпись программы:{' '}
            <b>
              {status.signatureChainToMatrica
                ? 'нашим ключом'
                : status.executableSigned
                  ? `чужая (${status.signerSubject ?? 'неизвестно'})`
                  : 'нет'}
            </b>
          </div>
          {status.probeError ? (
            <div style={{ fontSize: 13, color: 'var(--tone-warn-text)' }}>
              Состояние проверить не удалось: {status.probeError}
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ color: 'var(--subtle)' }}>Проверяю состояние…</div>
      )}

      {steps.map((step) => (
        <div
          key={step.id}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '8px 10px',
            display: 'grid',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{step.title}</div>
            {step.admin ? (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '1px 6px',
                  borderRadius: 999,
                  background: 'var(--tone-warn-bg)',
                  border: '1px solid var(--tone-warn-border)',
                  color: 'var(--tone-warn-text)',
                  whiteSpace: 'nowrap',
                }}
              >
                нужен системный администратор
              </span>
            ) : null}
          </div>
          <div style={{ fontSize: 13, color: 'var(--subtle)' }}>{step.detail}</div>
          {step.id === 'install-user' && props.onInstallUser ? (
            <div>
              <Button size="sm" onClick={props.onInstallUser} disabled={props.busy}>
                Поставить в моё хранилище (без прав администратора)
              </Button>
            </div>
          ) : null}
          {step.id === 'install-machine' && props.onInstallMachine ? (
            <div>
              <Button size="sm" tone="warn" onClick={props.onInstallMachine} disabled={props.busy}>
                Установить на всю машину (попросит права администратора)
              </Button>
            </div>
          ) : null}
        </div>
      ))}

      {instructions.length > 0 ? (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, display: 'grid', gap: 6 }}>
          {/* Старый способ (списки исключений руками) для наших файлов не нужен — и без
              этой строки путь в настройках Касперского читается как приглашение вносить
              исключения заново. */}
          <div data-trust-root-legacy-note style={{ fontSize: 12, color: 'var(--subtle)' }}>
            {trustRootLegacyNote()}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button size="sm" variant="ghost" onClick={() => setAdminOpen((v) => !v)}>
              {adminOpen ? 'Скрыть' : 'Что делать системному администратору'}
            </Button>
            {props.onRefresh ? (
              <Button size="sm" variant="ghost" onClick={props.onRefresh} disabled={props.busy}>
                Проверить заново
              </Button>
            ) : null}
          </div>
          {adminOpen ? (
            <div
              data-trust-root-admin
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '8px 10px',
                display: 'grid',
                gap: 6,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                Инструкция для системного администратора — можно переслать в заявку
              </div>
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--subtle)', display: 'grid', gap: 4 }}>
                {instructions.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ol>
              <div>
                <Button size="sm" variant="ghost" onClick={() => void copyInstructions()}>
                  {copied ? 'Скопировано' : 'Скопировать инструкцию'}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
