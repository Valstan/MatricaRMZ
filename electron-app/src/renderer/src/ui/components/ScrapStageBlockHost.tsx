import React, { useEffect, useState } from 'react';

import { ScrapStageBlockDialog, type ScrapStageBlockInfo } from './ScrapStageBlockDialog.js';
import { closeScrapStageBlock, resolveScrapStageBlock, subscribeScrapStageBlock } from '../utils/scrapStageGate.js';

/**
 * Хост окна гейта утиля (промт КАРМАНА #170).
 *
 * Стоит один раз в `App.tsx`: окно общее для всех экранов, которые заводят этап, —
 * карточки двигателя, списка, производственной программы и массового добавления.
 */
export function ScrapStageBlockHost() {
  const [info, setInfo] = useState<ScrapStageBlockInfo | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);

  useEffect(() => subscribeScrapStageBlock(setInfo), []);

  useEffect(() => {
    let alive = true;
    void window.matrica.engineScrap
      .reasons()
      .then((res) => {
        if (alive && res?.ok && Array.isArray(res.reasons)) setReasons(res.reasons);
      })
      .catch(() => {
        /* причины по умолчанию — в самом окне */
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <ScrapStageBlockDialog
      info={info}
      reasons={reasons}
      onCancel={closeScrapStageBlock}
      onResolved={(_info, warning) => resolveScrapStageBlock(warning)}
    />
  );
}
