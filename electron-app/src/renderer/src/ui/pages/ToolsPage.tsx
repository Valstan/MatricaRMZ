import React from 'react';
import { Button } from '../components/Button.js';
import { NomenclatureDirectoryPage } from './NomenclatureDirectoryPage.js';
import { TOOLS_PRESET } from './nomenclatureDirectoryPresets.js';

export function ToolsPage(props: {
  onOpen: (id: string) => Promise<void>;
  onOpenNomenclatureCatalog?: () => void;
  onOpenProperties: () => void;
  canCreate: boolean;
  canDelete: boolean;
}) {
  return (
    <NomenclatureDirectoryPage
      onOpen={props.onOpen}
      {...(props.onOpenNomenclatureCatalog ? { onOpenNomenclatureCatalog: props.onOpenNomenclatureCatalog } : {})}
      canCreate={props.canCreate}
      {...TOOLS_PRESET}
      secondaryAction={
        <Button variant="ghost" onClick={props.onOpenProperties}>
          Справочник свойств
        </Button>
      }
    />
  );
}
