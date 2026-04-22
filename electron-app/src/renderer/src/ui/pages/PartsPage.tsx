import React from 'react';
import { NomenclatureDirectoryPage } from './NomenclatureDirectoryPage.js';
import { PARTS_PRESET } from './nomenclatureDirectoryPresets.js';

export function PartsPage(props: {
  onOpen: (id: string) => Promise<void>;
  onOpenNomenclatureCatalog?: () => void;
  canCreate: boolean;
  canDelete: boolean;
}) {
  return (
    <NomenclatureDirectoryPage
      onOpen={props.onOpen}
      onOpenNomenclatureCatalog={props.onOpenNomenclatureCatalog}
      canCreate={props.canCreate}
      {...PARTS_PRESET}
    />
  );
}
