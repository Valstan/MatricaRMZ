import React from 'react';

import { NomenclatureDirectoryPage } from './NomenclatureDirectoryPage.js';
import { PRODUCTS_PRESET } from './nomenclatureDirectoryPresets.js';

export function ProductsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canDelete: boolean;
  canViewMasterData: boolean;
}) {
  return (
    <NomenclatureDirectoryPage
      onOpen={props.onOpen}
      canCreate={props.canCreate}
      canView={props.canViewMasterData}
      noAccessText="Недостаточно прав для просмотра товаров."
      {...PRODUCTS_PRESET}
    />
  );
}
