import React from 'react';
import { NomenclatureDirectoryPage } from './NomenclatureDirectoryPage.js';
import { ENGINE_BRANDS_PRESET } from './nomenclatureDirectoryPresets.js';

export function EngineBrandsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canViewMasterData: boolean;
}) {
  return (
    <NomenclatureDirectoryPage
      onOpen={props.onOpen}
      canCreate={props.canCreate}
      canView={props.canViewMasterData}
      noAccessText="Недостаточно прав для просмотра марок двигателя."
      {...ENGINE_BRANDS_PRESET}
    />
  );
}
