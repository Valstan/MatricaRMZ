import React from 'react';

import { NomenclatureDirectoryPage } from './NomenclatureDirectoryPage.js';
import { SERVICES_PRESET } from './nomenclatureDirectoryPresets.js';

export function ServicesPage(props: {
  onOpen: (id: string) => Promise<void>;
  onOpenNomenclatureCatalog?: () => void;
  canCreate: boolean;
  canDelete: boolean;
  canViewMasterData: boolean;
}) {
  return (
    <NomenclatureDirectoryPage
      onOpen={props.onOpen}
      {...(props.onOpenNomenclatureCatalog ? { onOpenNomenclatureCatalog: props.onOpenNomenclatureCatalog } : {})}
      canCreate={props.canCreate}
      canView={props.canViewMasterData}
      noAccessText="Недостаточно прав для просмотра услуг."
      {...SERVICES_PRESET}
    />
  );
}
