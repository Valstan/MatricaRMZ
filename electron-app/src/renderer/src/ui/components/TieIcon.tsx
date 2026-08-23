// Красный пионерский галстук — значок кнопки «Добавить на Рабочий стол» (этап B плана
// «рабочий стол и человеко-понятные названия»). Рисуем сами: картинка из интернета —
// правовой риск, программа офлайн. Геометрия рассчитана на 16 px: дуга-обхват, узел,
// две косынки — ни одной детали тоньше пикселя. Красный намеренно НЕ берётся из акцента
// темы (галстук узнаваем именно цветом) — оттенок правит тема через `--tie-red`;
// незакреплённое состояние — контур currentColor, как было у звезды «Быстрого запуска».
export function TieIcon(props: { active: boolean; size?: number }) {
  const size = props.size ?? 16;
  const paint = props.active
    ? { fill: 'var(--tie-red, #d92b1f)', stroke: 'var(--tie-red, #d92b1f)' }
    : { fill: 'none', stroke: 'currentColor' };
  return (
    <svg
      className="tie-icon"
      data-active={props.active ? '1' : undefined}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {/* дуга-обхват вокруг шеи */}
      <path d="M1.5 2.5 C4 8.2, 12 8.2, 14.5 2.5" fill="none" stroke={paint.stroke} strokeWidth="1.8" strokeLinecap="round" />
      {/* узел */}
      <rect x="6.2" y="6.6" width="3.6" height="2.8" rx="0.9" fill={paint.fill} stroke={paint.stroke} strokeWidth="1.2" strokeLinejoin="round" />
      {/* косынки: длинная и короткая, как у настоящего — завязан вручную */}
      <path d="M6.4 9.4 L7.6 15 L9.1 9.6 Z" fill={paint.fill} stroke={paint.stroke} strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8.6 9.6 L10.4 13.6 L10.8 9.3 Z" fill={paint.fill} stroke={paint.stroke} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
