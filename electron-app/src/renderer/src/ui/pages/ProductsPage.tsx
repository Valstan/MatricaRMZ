import React from 'react';

import { NomenclatureDirectoryPage } from './NomenclatureDirectoryPage.js';
import { PRODUCTS_PRESET } from './nomenclatureDirectoryPresets.js';

export function ProductsPage(props: {
  onOpen: (id: string) => Promise<void>;
  onOpenNomenclatureCatalog?: () => void;
  onCreateDeferred?: () => void;
  canCreate: boolean;
  canDelete: boolean;
  canViewMasterData: boolean;
}) {
  return (
    <NomenclatureDirectoryPage
      onOpen={props.onOpen}
      {...(props.onOpenNomenclatureCatalog ? { onOpenNomenclatureCatalog: props.onOpenNomenclatureCatalog } : {})}
      {...(props.onCreateDeferred ? { onCreateDeferred: props.onCreateDeferred } : {})}
      canCreate={props.canCreate}
      canView={props.canViewMasterData}
      noAccessText="Недостаточно прав для просмотра товаров."
      {...PRODUCTS_PRESET}
    />
  );
}
