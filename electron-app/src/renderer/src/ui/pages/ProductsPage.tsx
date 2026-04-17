import React from 'react';

import { MasterdataDirectoryPage } from './MasterdataDirectoryPage.js';

export function ProductsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canDelete: boolean;
  canViewMasterData: boolean;
}) {
  return (
    <MasterdataDirectoryPage
      typeCode="product"
      titleLabel="Товары"
      emptyText="Нет товаров"
      searchPlaceholder="Поиск товаров..."
      createButtonText="Добавить товар"
      defaultName="Новый товар"
      onOpen={props.onOpen}
      canCreate={props.canCreate}
      canView={props.canViewMasterData}
      noAccessText="Недостаточно прав для просмотра товаров."
    />
  );
}
