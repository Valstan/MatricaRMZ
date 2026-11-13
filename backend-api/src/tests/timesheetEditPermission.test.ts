import { describe, expect, it } from 'vitest';

import { actorIsAuthor, canEditTimesheet } from '../services/timesheetService.js';

// Правило владельца (13.11.2026): «редактировать все могут только свои табеля, чужие
// портить нельзя и удалять чужие нельзя, чужие табеля можно только смотреть».
// Значит правит ТОЛЬКО автор — галки «разрешить редактирование другим» больше нет,
// и обхода через allow_others_edit тоже нет.
describe('timesheet edit permission gate', () => {
  it('автор правит свой табель', () => {
    expect(canEditTimesheet({ createdBy: 'ivan', allowOthersEdit: false }, 'ivan')).toBe(true);
    expect(canEditTimesheet({ createdBy: 'ivan', allowOthersEdit: true }, 'ivan')).toBe(true);
  });

  it('чужой табель править нельзя — даже если автор раньше разрешал', () => {
    expect(canEditTimesheet({ createdBy: 'ivan', allowOthersEdit: false }, 'petr')).toBe(false);
    expect(canEditTimesheet({ createdBy: 'ivan', allowOthersEdit: true }, 'petr')).toBe(false);
  });

  it('легаси-табель без автора забирает себе первый же редактор', () => {
    expect(canEditTimesheet({ createdBy: null, allowOthersEdit: false }, 'petr')).toBe(true);
    expect(canEditTimesheet({ createdBy: null, allowOthersEdit: false }, null)).toBe(true);
  });

  it('автор match — регистр и пробелы не важны', () => {
    expect(actorIsAuthor('Ivan', ' ivan ')).toBe(true);
    expect(actorIsAuthor('ivan', 'petr')).toBe(false);
    expect(actorIsAuthor(null, 'ivan')).toBe(false);
  });

  it('без актора править табель нельзя', () => {
    expect(actorIsAuthor('ivan', undefined)).toBe(false);
    expect(canEditTimesheet({ createdBy: 'ivan', allowOthersEdit: false }, undefined)).toBe(false);
  });
});
