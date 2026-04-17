import React from 'react';

import { MasterdataDirectoryPage } from './MasterdataDirectoryPage.js';

export function EngineBrandsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canViewMasterData: boolean;
}) {
  return (
    <MasterdataDirectoryPage
      typeCode="engine_brand"
      titleLabel="Марки двигателей"
      emptyText="Нет марок двигателя"
      searchPlaceholder="Поиск марок двигателя..."
      createButtonText="Добавить марку"
      defaultName="Новая марка двигателя"
      onOpen={props.onOpen}
      canCreate={props.canCreate}
      canView={props.canViewMasterData}
      noAccessText="Недостаточно прав для просмотра марок двигателя."
    />
  );
}
