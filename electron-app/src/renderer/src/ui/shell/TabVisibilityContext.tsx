import React from 'react';

// «Моя вкладка сейчас видна». Ортогонально document.visibilityState: pollWhenVisible и
// liveDataService знают только про СВЁРНУТОЕ ОКНО, а с keep-alive страница может быть
// смонтирована и при этом скрыта соседней вкладкой.
//
// Провайдер ставит только оболочка v3 вокруг панели. Вне его (экран входа, вторая панель
// сравнения, любой код без оболочки) действует замороженный дефолт visible:true —
// забытая обёртка обязана давать прежнее поведение, а не тишину.

export type TabVisibility = {
  visible: boolean;
  /**
   * Счётчик показов панели. Нужен эффектам, чей пересчёт зависит от геометрии
   * (замер высоты табеля, автоскролл): их deps при смене видимости не меняются,
   * поэтому одного флага мало.
   */
  shownSeq: number;
};

const DEFAULT_TAB_VISIBILITY: TabVisibility = Object.freeze({ visible: true, shownSeq: 0 });

const TabVisibilityContext = React.createContext<TabVisibility>(DEFAULT_TAB_VISIBILITY);

export function TabVisibilityProvider(props: { visible: boolean; children: React.ReactNode }) {
  const [shownSeq, setShownSeq] = React.useState(() => (props.visible ? 1 : 0));
  const prevVisibleRef = React.useRef(props.visible);

  React.useEffect(() => {
    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = props.visible;
    if (props.visible && !wasVisible) setShownSeq((n) => n + 1);
  }, [props.visible]);

  const value = React.useMemo<TabVisibility>(
    () => ({ visible: props.visible, shownSeq }),
    [props.visible, shownSeq],
  );

  return <TabVisibilityContext.Provider value={value}>{props.children}</TabVisibilityContext.Provider>;
}

export function useTabVisibility(): TabVisibility {
  return React.useContext(TabVisibilityContext);
}

export function useTabVisible(): boolean {
  return React.useContext(TabVisibilityContext).visible;
}

/**
 * Латч для mount-only подписок (setInterval, pollWhenVisible): читать `.current` ВНУТРИ
 * колбэка. Флаг в deps пересоздавал бы подписку на каждое переключение вкладки.
 */
export function useTabVisibleRef(): React.MutableRefObject<boolean> {
  const { visible } = React.useContext(TabVisibilityContext);
  const ref = React.useRef(visible);
  ref.current = visible;
  return ref;
}

/** Панель снова показали — обновить то, что протухло, пока её не было видно. */
export function useOnTabVisible(callback: () => void): void {
  const { shownSeq } = React.useContext(TabVisibilityContext);
  const cbRef = React.useRef(callback);
  cbRef.current = callback;
  const firstRef = React.useRef(true);
  React.useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    cbRef.current();
  }, [shownSeq]);
}
