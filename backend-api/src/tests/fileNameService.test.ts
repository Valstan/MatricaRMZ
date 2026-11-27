import { describe, expect, it } from 'vitest';

import { checkFileName, MAX_FILE_NAME_LENGTH } from '../services/fileNameService.js';

// Имя файла при переименовании (владелец 27.11.2026). Проверка живёт в общем модуле
// (без БД), а маршрут зовёт её — чтобы правило «как называется файл» было одно.

describe('имя файла при переименовании', () => {
  it('обычное имя принимается и обрезается по краям', () => {
    const res = checkFileName('  Д-100 дефектовка.jpg  ');
    expect(res).toEqual({ ok: true, name: 'Д-100 дефектовка.jpg' });
  });

  it('пустое имя — отказ с понятной причиной', () => {
    const res = checkFileName('   ');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('не указано');
  });

  it('запрещённые символы — отказ, а не молчаливая правка', () => {
    // Оператор должен увидеть, почему имя не принято: «куда делось моё Д-100.jpg».
    for (const bad of ['a/b.jpg', 'a\\b.jpg', 'a:b.jpg', 'a*b.jpg', 'a?b.jpg', 'a"b.jpg', 'a<b.jpg', 'a>b.jpg', 'a|b.jpg']) {
      const res = checkFileName(bad);
      expect(res.ok, `имя ${bad} должно отклоняться`).toBe(false);
    }
  });

  it('слишком длинное имя — отказ', () => {
    const res = checkFileName('я'.repeat(MAX_FILE_NAME_LENGTH + 1));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('длиннее');
  });

  it('имя на границе потолка принимается', () => {
    const res = checkFileName('я'.repeat(MAX_FILE_NAME_LENGTH));
    expect(res.ok).toBe(true);
  });
});
