import { describe, it, expect } from 'vitest';

import { deltaAssemblyTempPath } from './installerNaming.js';
import { decideStaleLock, isDeltaAssemblyLeftover, UPDATE_LOCK_MAX_AGE_MS } from './updateLockPolicy.js';

const STABLE = 'matrica_rmz_update.exe';

describe('update lock policy — «обновление не скачивается» regression', () => {
  it('НЕ снимает lock, пока владелец жив (это и был полевой баг)', () => {
    // Клиент качает delta → пользователь закрывает окно → следующий запуск видел свежий
    // lock, снимал его и стирал дельта-базис. Загрузка начиналась с нуля каждый раз.
    const d = decideStaleLock({ owner: 'alive', lockAgeMs: 30_000 });
    expect(d.release).toBe(false);
  });

  it('снимает lock, если процесс-владелец завершился — не дожидаясь порога', () => {
    const d = decideStaleLock({ owner: 'gone', lockAgeMs: 5_000 });
    expect(d.release).toBe(true);
  });

  it('протухший lock снимается даже при «живом» владельце — PID мог быть переиспользован', () => {
    // Иначе чужой процесс, случайно получивший тот же номер, заморозил бы обновления навсегда.
    const d = decideStaleLock({ owner: 'alive', lockAgeMs: UPDATE_LOCK_MAX_AGE_MS + 1 });
    expect(d.release).toBe(true);
  });

  it('без опознанного владельца держит свежий lock и снимает протухший', () => {
    expect(decideStaleLock({ owner: 'unknown', lockAgeMs: 60_000 }).release).toBe(false);
    expect(decideStaleLock({ owner: 'unknown', lockAgeMs: UPDATE_LOCK_MAX_AGE_MS + 1 }).release).toBe(true);
  });

  it('порог совпадает с тем, что держит acquireUpdateLock (2 часа)', () => {
    // Расхождение порогов и было вторым слоем бага: acquire держал lock 2ч, recover сносил сразу.
    expect(UPDATE_LOCK_MAX_AGE_MS).toBe(2 * 60 * 60 * 1000);
  });

  it('мусором считает ТОЛЬКО недособранный delta-temp, но не топливо delta', () => {
    const tmpName = deltaAssemblyTempPath(STABLE);
    expect(isDeltaAssemblyLeftover(tmpName, STABLE)).toBe(true);

    // Эти три файла — топливо для следующей delta; recover обязан их сохранить.
    expect(isDeltaAssemblyLeftover(STABLE, STABLE)).toBe(false);
    expect(isDeltaAssemblyLeftover(`${STABLE}.blockmap`, STABLE)).toBe(false);
    expect(isDeltaAssemblyLeftover(`${STABLE}.cache.json`, STABLE)).toBe(false);
    expect(isDeltaAssemblyLeftover('pending-update.json', STABLE)).toBe(false);
  });
});
