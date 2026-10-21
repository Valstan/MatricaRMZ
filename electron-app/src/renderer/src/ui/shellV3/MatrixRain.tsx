import React, { useEffect, useRef } from 'react';

/**
 * «Матричный дождь» для плашки Ииваныча (владелец 21.10.2026).
 *
 * Это украшение, а не данные: частота низкая (12 к/с), при скрытом окне кадры не считаются,
 * при `prefers-reduced-motion` рисуется один статичный кадр. Иначе анимация на плашке
 * конкурировала бы за кадры со списками двигателей — а плашка висит у всех клиентов.
 */
const GLYPHS = '0123456789АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ';
const FONT_PX = 10;
const FPS = 12;

export function MatrixRain(props: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    let drops: number[] = [];
    let width = 0;
    let height = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const columns = Math.max(1, Math.floor(width / FONT_PX));
      drops = Array.from({ length: columns }, (_, i) => drops[i] ?? Math.random() * (height / FONT_PX));
      ctx.clearRect(0, 0, width, height);
    };

    const step = () => {
      // Хвосты гасим «стиранием», а не заливкой: фон плашки задаёт CSS, и красить его
      // канвасом значило бы держать в JS второй источник правды о цвете.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.14)';
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.font = `${FONT_PX}px ui-monospace, Consolas, monospace`;
      for (let i = 0; i < drops.length; i += 1) {
        const glyph = GLYPHS[(Math.random() * GLYPHS.length) | 0] ?? '0';
        const x = i * FONT_PX;
        const y = (drops[i] ?? 0) * FONT_PX;
        ctx.fillStyle = 'rgba(185, 28, 28, 0.55)';
        ctx.fillText(glyph, x, y);
        if (y > height && Math.random() > 0.94) drops[i] = 0;
        else drops[i] = (drops[i] ?? 0) + 1;
      }
    };

    resize();
    if (reduced) {
      step();
      return undefined;
    }

    let raf = 0;
    let last = 0;
    const tick = (ts: number) => {
      raf = window.requestAnimationFrame(tick);
      if (document.visibilityState === 'hidden') return;
      if (ts - last < 1000 / FPS) return;
      last = ts;
      step();
    };
    raf = window.requestAnimationFrame(tick);

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
    observer?.observe(canvas);
    return () => {
      window.cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className={props.className ?? ''} aria-hidden="true" />;
}
