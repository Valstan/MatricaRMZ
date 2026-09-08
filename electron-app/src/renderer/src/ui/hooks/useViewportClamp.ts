import { useCallback, useEffect, useState } from 'react';

/**
 * Держит выпадающую панель в границах окна (владелец 09.09.2026: меню тулбара и «Колонки
 * списка» уезжали за правый край, и выбрать в них было нечего).
 *
 * Панель позиционируется относительно своей кнопки, а кнопка может стоять у самого края —
 * особенно в узкой панели двухпанельного экрана. Считаем сдвиг ПОСЛЕ отрисовки, по факту
 * измерения: заранее «как надо» не вычислить, ширина панели зависит от её содержимого.
 */
export function useViewportClamp(open: boolean): {
  ref: (el: HTMLElement | null) => void;
  style: { transform?: string; maxHeight?: number };
} {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [shift, setShift] = useState<{ x: number; maxHeight?: number }>({ x: 0 });

  const ref = useCallback((el: HTMLElement | null) => setNode(el), []);

  useEffect(() => {
    if (!open || !node) {
      setShift({ x: 0 });
      return;
    }
    const measure = () => {
      // Меряем без прежнего сдвига, иначе поправка накапливается на каждом пересчёте.
      node.style.transform = '';
      const rect = node.getBoundingClientRect();
      const margin = 8;
      let x = 0;
      if (rect.right > window.innerWidth - margin) x = -(rect.right - (window.innerWidth - margin));
      if (rect.left + x < margin) x = margin - rect.left;
      const available = window.innerHeight - rect.top - margin;
      setShift({ x, ...(available > 80 && rect.height > available ? { maxHeight: available } : {}) });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, node]);

  return {
    ref,
    style: {
      ...(shift.x ? { transform: `translateX(${Math.round(shift.x)}px)` } : {}),
      ...(shift.maxHeight ? { maxHeight: shift.maxHeight } : {}),
    },
  };
}
