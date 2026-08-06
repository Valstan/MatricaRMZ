import React from 'react';

// Выдвижная панель хрома (пока одна — «РАЗДЕЛЫ» слева). Всё оформление в chromeShell.css;
// компонент нужен ради одного невидимого инварианта: как только доводка закончилась,
// с открытой панели снимается transform. С transform'ом панель становится containing
// block'ом для position:fixed внутри неё — контекст-меню разделов начинает клипаться
// прокруткой самой панели и уезжает мимо пальца.

/** Страховка на случай, если transitionend не придёт (свёрнутое окно, reduced-motion). */
const SETTLE_FALLBACK_MS = 220;

export function ChromeDrawer(props: {
  open: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLElement | null>(null);

  // Доводку включаем со второго кадра — см. комментарий у правила [data-mx-ready].
  React.useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (ref.current) ref.current.dataset.mxReady = '1';
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    delete el.dataset.mxSettled;
    if (!props.open) return;
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      if (ref.current) ref.current.dataset.mxSettled = '1';
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName === 'transform') settle();
    };
    el.addEventListener('transitionend', onEnd);
    const timer = setTimeout(settle, SETTLE_FALLBACK_MS);
    return () => {
      el.removeEventListener('transitionend', onEnd);
      clearTimeout(timer);
    };
  }, [props.open]);

  return (
    <aside
      ref={ref}
      className={`mx-drawer mx-drawer--left${props.className ? ` ${props.className}` : ''}`}
      data-mx-open={props.open ? '1' : '0'}
    >
      {props.children}
    </aside>
  );
}
