import { describe, expect, it } from 'vitest';

import {
  MATRICA_ROOT_CA_SUBJECT,
  MATRICA_ROOT_CA_THUMBPRINT,
  TRUST_ROOT_NOTICE_COOLDOWN_MS,
  adminInstructions,
  isTrustRootHealthy,
  planTrustRootSteps,
  trustRootNoticeDecision,
  trustRootLegacyNote,
  trustRootSignatureLabel,
  trustRootSummary,
  type TrustRootStatus,
} from './trustRoot.js';

function status(over: Partial<TrustRootStatus> = {}): TrustRootStatus {
  return {
    platform: 'win32',
    rootSubject: MATRICA_ROOT_CA_SUBJECT,
    rootThumbprint: MATRICA_ROOT_CA_THUMBPRINT,
    stores: [],
    machineTrusted: false,
    userTrusted: false,
    executableSigned: false,
    signatureChainToMatrica: false,
    signatureTrusted: false,
    signerSubject: null,
    probeError: null,
    ...over,
  };
}

describe('корень доверия: шаги', () => {
  it('на здоровой машине остаётся только шаг Касперского', () => {
    const steps = planTrustRootSteps(status({ machineTrusted: true, userTrusted: true }));
    expect(steps.map((s) => s.id)).toEqual(['kaspersky-gui']);
    expect(steps.every((s) => s.admin)).toBe(true);
  });

  it('корня нет нигде: сначала пользовательское хранилище (без админа), потом машина, потом Касперский', () => {
    const steps = planTrustRootSteps(status());
    expect(steps.map((s) => s.id)).toEqual(['install-user', 'install-machine', 'kaspersky-gui']);
    // Пользовательский шаг программа делает сама и сама же — без прав администратора.
    const userStep = steps[0];
    expect(userStep.admin).toBe(false);
    expect(userStep.by).toBe('program');
    expect(steps[1].by).toBe('admin');
  });

  it('корень есть только в профиле: шаг пользователя пропускаем, машинный — нет', () => {
    const steps = planTrustRootSteps(status({ userTrusted: true }));
    expect(steps.map((s) => s.id)).toEqual(['install-machine', 'kaspersky-gui']);
  });

  it('опрос не прошёл — это «состояние неизвестно», а не «корня нет»', () => {
    const steps = planTrustRootSteps(status({ probeError: 'powershell не найден' }));
    expect(steps.map((s) => s.id)).toEqual(['none']);
    expect(steps[0].detail).toContain('powershell не найден');
    // И главное: никаких «установите корень» — иначе на исправной машине будем ругаться.
    expect(steps[0].detail).not.toContain('Поставить корень');
  });

  it('не Windows — шагов нет вовсе', () => {
    const steps = planTrustRootSteps(status({ platform: 'other' }));
    expect(steps.map((s) => s.id)).toEqual(['none']);
    expect(isTrustRootHealthy(status({ platform: 'other' }))).toBe(false);
  });
});

describe('корень доверия: здоровье и короткая строка', () => {
  it('здоровая машина — корень в машинном хранилище', () => {
    expect(isTrustRootHealthy(status({ machineTrusted: true }))).toBe(true);
    expect(isTrustRootHealthy(status({ machineTrusted: false }))).toBe(false);
    expect(isTrustRootHealthy(status({ machineTrusted: true, probeError: 'сбой' }))).toBe(false);
  });

  it('короткая строка различает три состояния и не врёт', () => {
    expect(trustRootSummary(status({ machineTrusted: true }))).toContain('машинном хранилище');
    expect(trustRootSummary(status({ userTrusted: true }))).toContain('администратора');
    expect(trustRootSummary(status())).toContain('поставит его сам');
    expect(trustRootSummary(status({ probeError: 'сбой' }))).toContain('Не удалось проверить');
  });
});

describe('подсказка при запуске: показывать или нет', () => {
  const now = 1_800_000_000_000;

  it('нужна, когда корень не в машинном хранилище', () => {
    expect(trustRootNoticeDecision(status(), 0, now)).toEqual({ show: true, reason: 'needed' });
  });

  it('не нужна, когда корень в машинном хранилище — задача закрыта', () => {
    expect(trustRootNoticeDecision(status({ machineTrusted: true }), 0, now).show).toBe(false);
  });

  it('не нужна, когда состояние неизвестно: сбой опроса — не повод ругаться', () => {
    const d = trustRootNoticeDecision(status({ probeError: 'сбой' }), 0, now);
    expect(d.show).toBe(false);
    expect(d.reason).toBe('unknown-state');
  });

  it('не нужна на других системах', () => {
    expect(trustRootNoticeDecision(status({ platform: 'other' }), 0, now).reason).toBe('not-windows');
  });

  it('показанная подсказка не лезет повторно в течение недели', () => {
    const shown = now - 1000;
    expect(trustRootNoticeDecision(status(), shown, now).reason).toBe('cooldown');
    // А через неделю — снова показываем: шаг мог остаться несделанным.
    const later = shown + TRUST_ROOT_NOTICE_COOLDOWN_MS + 1;
    expect(trustRootNoticeDecision(status(), shown, later).show).toBe(true);
  });
});

describe('корень доверия: инструкция администратору', () => {
  it('инструкция говорит, что делать, и признаёт, что Касперский программно не настроить', () => {
    const lines = adminInstructions(status());
    const text = lines.join('\n');
    expect(text).toContain(MATRICA_ROOT_CA_THUMBPRINT.slice(0, 8));
    expect(text).toContain('LocalMachine\\Root');
    expect(text).toContain('Доверенное системное хранилище сертификатов');
    expect(text).toContain('Самозащита');
    // Шаг должен быть выполним человеком — с команлой, а не только словами.
    expect(text).toContain('install-root-on-machine.ps1');
  });

  it('говорит прямо: в «Исключениях» и «Доверенных программах» добавлять нечего', () => {
    // Владелец (10.11.2026): старое описание ручного добавления исключений путает
    // операторов — путь в настройках Касперского читали как приглашение вносить списки
    // заново. Для наших файлов их закрывает подпись.
    const text = adminInstructions(status()).join('\n');
    expect(text).toContain('одна галочка');
    expect(text).toContain('добавлять не нужно');
    expect(text).toContain('закрывает подпись');
  });

  it('не замалчивает про исключения на данные — подпись на них не распространяется', () => {
    // Гарантия переехала в заметку для оператора: инструкция админу про подпись короткая,
    // а про исключения на данные сказано отдельно и один раз.
    const note = trustRootLegacyNote();
    expect(note).toContain('исключения на папки с данными');
    expect(note).toContain('помощник по антивирусу');
  });
  it('на настроенной машине шаг установки не предлагается заново', () => {
    const text = adminInstructions(status({ machineTrusted: true })).join('\n');
    expect(text).toContain('уже настроены');
    expect(text).not.toContain('install-root-on-machine.ps1');
  });
});

describe('корень доверия: заметка про старый способ', () => {
  it('говорит оператору, что ручные списки исключений больше не нужны', () => {
    const note = trustRootLegacyNote();
    expect(note).toContain('больше не нужны');
    expect(note).toContain('подпись');
    // И что осталось — только исключения на папки с данными.
    expect(note).toContain('данными');
  });
});

describe('корень доверия: как названа подпись', () => {
  it('наш ключ — доверие Касперского по подписи', () => {
    const label = trustRootSignatureLabel(status({ signatureChainToMatrica: true, executableSigned: true }));
    expect(label).toContain('нашим ключом');
    expect(label).toContain('Касперский доверяет');
  });

  it('другой ключ — без слова «чужая»: в сборке для разработки это нормально', () => {
    // Владелец (10.11.2026): слово «чужая» в инструкции пугало операторов.
    const label = trustRootSignatureLabel(status({ executableSigned: true }));
    expect(label).not.toContain('чужая');
    expect(label).toContain('нормально');
  });

  it('подписи нет — говорим прямо, без оценок', () => {
    expect(trustRootSignatureLabel(status())).toBe('подписи нет');
  });
});
