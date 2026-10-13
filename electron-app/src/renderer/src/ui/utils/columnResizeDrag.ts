/**
 * Чистая машина drag ресайза колонки (A1: вис при тяге ширины).
 *
 * Без React и DOM — только арифметика и состояние, поэтому покрывается
 * обычным unit-тестом (jsdom в репо нет, витрина — `node`). Компонент
 * (`ColumnResizeHandle`) держит её в ref и отвечает за pointer-capture,
 * rAF-дроссель и сброс; сюда приходят уже извлечённые координаты.
 *
 * Инвариант: после `finish()`/`abort()` машина пуста — следующий `move`
 * без `start` ничего не даёт. Залипшего drag (движения меняют ширину после
 * отпускания) по построению нет.
 */

export type ResizeDragState = {
  startX: number;
  startW: number;
  moved: boolean;
  /** Последняя вычисленная ширина (startW + dx), сырая — клампит потребитель. */
  width: number;
};

export function createResizeDrag() {
  let current: ResizeDragState | null = null;
  return {
    /** Начало тяги. Возвращает false, если тяга уже идёт (повторный down). */
    start(startX: number, startW: number): boolean {
      if (current) return false;
      current = { startX, startW, moved: false, width: startW };
      return true;
    },
    /**
     * Движение. Возвращает ширину, только если порог пройден (dx > 3px)
     * и значение изменилось с прошлого раза; иначе null (лишний setState не нужен).
     */
    move(clientX: number): number | null {
      const d = current;
      if (!d) return null;
      const dx = clientX - d.startX;
      if (Math.abs(dx) <= 3) return null;
      d.moved = true;
      const width = d.startW + dx;
      if (width === d.width) return null;
      d.width = width;
      return width;
    },
    /** Конец тяги: true — было движение (надо коммитить), машина пустеет. */
    finish(): boolean {
      const moved = current?.moved ?? false;
      current = null;
      return moved;
    },
    /** Обрыв тяги без коммита (blur/unmount): машина пустеет. */
    abort(): void {
      current = null;
    },
    /** Для тестов: идёт ли тяга. */
    get active(): boolean {
      return current !== null;
    },
  };
}

export type ResizeDrag = ReturnType<typeof createResizeDrag>;
