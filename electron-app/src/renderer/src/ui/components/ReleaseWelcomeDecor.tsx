import type { CSSProperties } from 'react';

import type { ReleaseWelcomeVariant } from '@matricarmz/shared';

/**
 * Оформление окна приветствия (промт КАРМАНА #162).
 *
 * Три варианта живут в программе одновременно; какой показать — решает главный процесс
 * по `clientId` и номеру релиза, сюда приходит уже выбранный.
 *
 * Всё рисуется CSS-анимациями: парк машин слабый, тяжёлый DOM (canvas, сотни узлов)
 * в окне, которое открывается после каждого обновления, недопустим.
 */

export type EnginePartKind = 'gear' | 'piston' | 'bolt' | 'nut' | 'ring' | 'rod' | 'valve' | 'spark';

export function renderEnginePartSvg(kind: EnginePartKind) {
  switch (kind) {
    case 'gear':
      return (
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <g fill="currentColor">
            <path d="M30 2h4l1 6 6 1 3-5 3.5 2-1 6 5 4 5-3 2.5 3-4 5 2 6-6 1-1 6 5 3-2.5 3.5-6-1-4 5 3 5-3 2.5-5-3-6 1-1 6h-4l-1-6-6-1-3 5-3.5-2.5 3-5-5-4-5 3-2.5-3.5 5-4-2-6 6-1 1-6-5-3 2.5-3.5 6 1 4-5-3-5 3-2.5 5 3 6-1z" />
            <circle cx="32" cy="32" r="9" fill="rgba(15,23,42,0.55)" />
            <circle cx="32" cy="32" r="5.5" fill="currentColor" />
          </g>
        </svg>
      );
    case 'piston':
      return (
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <g fill="currentColor">
            <rect x="18" y="6" width="28" height="22" rx="3" />
            <rect x="20" y="9" width="24" height="2" fill="rgba(15,23,42,0.5)" />
            <rect x="20" y="13" width="24" height="2" fill="rgba(15,23,42,0.5)" />
            <rect x="20" y="17" width="24" height="2" fill="rgba(15,23,42,0.5)" />
            <rect x="28" y="28" width="8" height="14" />
            <circle cx="32" cy="50" r="9" fill="none" stroke="currentColor" strokeWidth="4" />
            <circle cx="32" cy="50" r="3" />
          </g>
        </svg>
      );
    case 'bolt':
      return (
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <g fill="currentColor">
            <polygon points="32,4 50,14 50,28 32,38 14,28 14,14" />
            <polygon points="32,12 44,18 44,26 32,32 20,26 20,18" fill="rgba(15,23,42,0.5)" />
            <rect x="29" y="34" width="6" height="26" />
            <path d="M28 38h8M28 42h8M28 46h8M28 50h8M28 54h8" stroke="rgba(15,23,42,0.45)" strokeWidth="1.5" />
          </g>
        </svg>
      );
    case 'nut':
      return (
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <g fill="currentColor">
            <polygon points="32,6 54,18 54,46 32,58 10,46 10,18" />
            <circle cx="32" cy="32" r="11" fill="rgba(15,23,42,0.6)" />
            <circle cx="32" cy="32" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
          </g>
        </svg>
      );
    case 'ring':
      return (
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <g fill="none" stroke="currentColor" strokeWidth="5">
            <circle cx="32" cy="32" r="22" />
          </g>
          <path d="M30 8h4l-1 4-2 0z" fill="currentColor" />
        </svg>
      );
    case 'rod':
      return (
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <g fill="currentColor">
            <circle cx="32" cy="12" r="9" />
            <circle cx="32" cy="12" r="4" fill="rgba(15,23,42,0.6)" />
            <path d="M28 18 L24 50 L40 50 L36 18 Z" />
            <ellipse cx="32" cy="54" rx="14" ry="6" />
            <ellipse cx="32" cy="54" rx="7" ry="3" fill="rgba(15,23,42,0.6)" />
          </g>
        </svg>
      );
    case 'valve':
      return (
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <g fill="currentColor">
            <ellipse cx="32" cy="50" rx="16" ry="8" />
            <ellipse cx="32" cy="50" rx="10" ry="4" fill="rgba(15,23,42,0.55)" />
            <rect x="29" y="8" width="6" height="40" />
            <rect x="26" y="6" width="12" height="4" />
          </g>
        </svg>
      );
    case 'spark':
      return (
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <g fill="currentColor">
            <rect x="26" y="4" width="12" height="10" rx="1.5" />
            <polygon points="22,16 42,16 40,22 24,22" />
            <polygon points="24,24 40,24 38,32 26,32" fill="rgba(15,23,42,0.55)" />
            <rect x="28" y="34" width="8" height="14" />
            <polygon points="30,48 34,48 32,60" />
          </g>
        </svg>
      );
    default:
      return null;
  }
}

/** Летающие детали завода — нынешнее сине-фиолетовое оформление. */
const AURORA_PARTS: Array<{ kind: EnginePartKind; cls: string }> = [
  { kind: 'gear', cls: 'release-welcome-part--gear-1' },
  { kind: 'piston', cls: 'release-welcome-part--piston-1' },
  { kind: 'bolt', cls: 'release-welcome-part--bolt-1' },
  { kind: 'nut', cls: 'release-welcome-part--nut-1' },
  { kind: 'ring', cls: 'release-welcome-part--ring-1' },
  { kind: 'gear', cls: 'release-welcome-part--gear-2' },
  { kind: 'rod', cls: 'release-welcome-part--rod-1' },
  { kind: 'valve', cls: 'release-welcome-part--valve-1' },
  { kind: 'spark', cls: 'release-welcome-part--spark-1' },
  { kind: 'gear', cls: 'release-welcome-part--gear-3' },
  { kind: 'bolt', cls: 'release-welcome-part--bolt-2' },
  { kind: 'ring', cls: 'release-welcome-part--ring-2' },
  { kind: 'nut', cls: 'release-welcome-part--nut-2' },
  { kind: 'piston', cls: 'release-welcome-part--piston-2' },
  { kind: 'gear', cls: 'release-welcome-part--gear-4' },
  { kind: 'piston', cls: 'release-welcome-part--piston-3' },
  { kind: 'bolt', cls: 'release-welcome-part--bolt-3' },
  { kind: 'nut', cls: 'release-welcome-part--nut-3' },
  { kind: 'ring', cls: 'release-welcome-part--ring-3' },
  { kind: 'rod', cls: 'release-welcome-part--rod-2' },
  { kind: 'valve', cls: 'release-welcome-part--valve-2' },
  { kind: 'spark', cls: 'release-welcome-part--spark-2' },
];

/** Побеги вьюнка: снизу вверх, на концах — детали завода. */
const VINES: Array<{ x: number; width: number; delay: number; kind: EnginePartKind }> = [
  { x: 7, width: 62, delay: 0.2, kind: 'piston' },
  { x: 21, width: 48, delay: 1.1, kind: 'gear' },
  { x: 33, width: 78, delay: 0.6, kind: 'valve' },
  { x: 47, width: 54, delay: 1.9, kind: 'nut' },
  { x: 58, width: 70, delay: 1.4, kind: 'ring' },
  { x: 71, width: 44, delay: 2.4, kind: 'bolt' },
  { x: 82, width: 60, delay: 0.9, kind: 'rod' },
  { x: 93, width: 50, delay: 2.8, kind: 'piston' },
];

/** Снежинки: размер, скорость, момент появления и куда их сдувает ветром. */
const FLAKES: Array<{ x: number; size: number; delay: number; duration: number; drift: number }> = [
  { x: 4, size: 9, delay: 0, duration: 9.5, drift: 6 },
  { x: 11, size: 6, delay: 1.7, duration: 12, drift: -9 },
  { x: 18, size: 12, delay: 0.6, duration: 8, drift: 4 },
  { x: 25, size: 7, delay: 2.9, duration: 13.5, drift: -12 },
  { x: 31, size: 10, delay: 1.2, duration: 10.5, drift: 8 },
  { x: 37, size: 5, delay: 3.6, duration: 14, drift: -5 },
  { x: 43, size: 11, delay: 0.3, duration: 9, drift: 10 },
  { x: 49, size: 7, delay: 2.1, duration: 12.5, drift: -7 },
  { x: 55, size: 9, delay: 4.2, duration: 11, drift: 5 },
  { x: 61, size: 6, delay: 1.4, duration: 13, drift: -11 },
  { x: 67, size: 12, delay: 2.6, duration: 8.8, drift: 9 },
  { x: 73, size: 5, delay: 0.9, duration: 14.5, drift: -4 },
  { x: 79, size: 10, delay: 3.2, duration: 10, drift: 7 },
  { x: 85, size: 7, delay: 1.9, duration: 12.8, drift: -13 },
  { x: 91, size: 11, delay: 5, duration: 9.2, drift: 3 },
  { x: 96, size: 6, delay: 2.3, duration: 13.2, drift: -8 },
];

/** Ёлочные игрушки, висят сверху. */
const ORNAMENTS: Array<{ x: number; delay: number; color: 'red' | 'green' | 'gold' }> = [
  { x: 9, delay: 0.2, color: 'red' },
  { x: 27, delay: 1.1, color: 'gold' },
  { x: 46, delay: 0.6, color: 'green' },
  { x: 64, delay: 1.7, color: 'red' },
  { x: 83, delay: 0.9, color: 'gold' },
];

export type ReleaseWelcomeDecorProps = {
  variant: ReleaseWelcomeVariant;
  /** Логотип завода (`data:`-URL). Файла от владельца пока нет — рисуем заглушку. */
  logoDataUrl?: string | null | undefined;
};

export function ReleaseWelcomeDecor({ variant, logoDataUrl }: ReleaseWelcomeDecorProps) {
  if (variant === 'vines') return <VinesDecor />;
  if (variant === 'snow') return <SnowDecor logoDataUrl={logoDataUrl} />;
  return <AuroraDecor />;
}

function AuroraDecor() {
  return (
    <div className="release-welcome-decor release-welcome-decor--aurora" aria-hidden="true">
      <div className="release-welcome-aurora release-welcome-aurora--one" />
      <div className="release-welcome-aurora release-welcome-aurora--two" />
      <div className="release-welcome-aurora release-welcome-aurora--three" />
      <div className="release-welcome-parts">
        {AURORA_PARTS.map((p, i) => (
          <span key={i} className={`release-welcome-part release-welcome-part--${p.kind} ${p.cls}`}>
            {renderEnginePartSvg(p.kind)}
          </span>
        ))}
      </div>
      <div className="release-welcome-embers">
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n} className={`release-welcome-ember release-welcome-ember--${n}`} />
        ))}
      </div>
    </div>
  );
}

function VinesDecor() {
  return (
    <div className="release-welcome-decor release-welcome-decor--vines" aria-hidden="true">
      {VINES.map((vine, i) => (
        <span
          key={i}
          className="release-welcome-vine"
          style={
            {
              left: `${vine.x}%`,
              width: `${vine.width}px`,
              animationDelay: `${vine.delay}s`,
              '--vine-delay': `${vine.delay}s`,
            } as CSSProperties
          }
        >
          <svg className="release-welcome-vine-stem" viewBox="0 0 60 240" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M30 240 C 56 192, 6 150, 34 100 C 58 56, 18 30, 30 4"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
          <span className="release-welcome-vine-leaf release-welcome-vine-leaf--one" />
          <span className="release-welcome-vine-leaf release-welcome-vine-leaf--two" />
          <span className={`release-welcome-vine-tip release-welcome-vine-tip--${vine.kind}`}>
            {renderEnginePartSvg(vine.kind)}
          </span>
        </span>
      ))}
    </div>
  );
}

function SnowDecor({ logoDataUrl }: { logoDataUrl?: string | null | undefined }) {
  return (
    <div className="release-welcome-decor release-welcome-decor--snow" aria-hidden="true">
      {/* Логотип — слой ниже снежинок: он летит на заднем плане. */}
      <div className="release-welcome-logo">
        <div className="release-welcome-logo-body">
          {logoDataUrl ? (
            <img className="release-welcome-logo-image" src={logoDataUrl} alt="" />
          ) : (
            <span className="release-welcome-logo-placeholder">ЛОГОТИП</span>
          )}
        </div>
      </div>
      <div className="release-welcome-snowdrift" />
      <div className="release-welcome-ornaments">
        {ORNAMENTS.map((o, i) => (
          <span
            key={i}
            className="release-welcome-ornament"
            style={{ left: `${o.x}%`, animationDelay: `${o.delay}s` }}
          >
            <span className="release-welcome-ornament-string" />
            <span className={`release-welcome-ornament-ball release-welcome-ornament-ball--${o.color}`} />
          </span>
        ))}
      </div>
      <div className="release-welcome-flakes">
        {FLAKES.map((f, i) => (
          <span
            key={i}
            className="release-welcome-flake"
            style={
              {
                left: `${f.x}%`,
                width: `${f.size}px`,
                height: `${f.size}px`,
                animationDelay: `${f.delay}s`,
                animationDuration: `${f.duration}s`,
                '--drift': `${f.drift}vw`,
                // Разброс по экрану на случай, когда анимации выключены.
                '--rest-y': `${12 + ((i * 37) % 74)}%`,
              } as CSSProperties
            }
          />
        ))}
      </div>
    </div>
  );
}
