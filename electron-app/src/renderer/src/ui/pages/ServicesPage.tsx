import React from 'react';

import { MasterdataDirectoryPage } from './MasterdataDirectoryPage.js';

export function ServicesPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canDelete: boolean;
  canViewMasterData: boolean;
}) {
  return (
    <MasterdataDirectoryPage
      typeCode="service"
      titleLabel="Услуги"
      emptyText="Нет услуг"
      searchPlaceholder="Поиск услуг..."
      createButtonText="Добавить услугу"
      defaultName="Новая услуга"
      onOpen={props.onOpen}
      canCreate={props.canCreate}
      canView={props.canViewMasterData}
      noAccessText="Недостаточно прав для просмотра услуг."
    />
  );
}
