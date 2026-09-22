import type { CountdownStatus } from '@matricarmz/shared';

// Подсветка строки двигателя по отсчёту срока ремонта из контракта, который идёт с даты
// поступления двигателя на завод (владелец 22.09.2026; план engine-payments-2026-07).
// Лестница как у contractProgressVisual: жёлтый — прошло больше половины срока, красный —
// остаток в последней пятой части срока или просрочка (пороги масштабируются под срок
// контракта — `countdownThresholds`). Отремонтированный двигатель и двигатель без даты
// поступления отсчёта не имеют — подсветки нет. Её же теряют забытые карточки (`stale`):
// замер на проде 22.09 показал, что красным горел незакрытый учёт, а не просрочка ремонта.
// Из списка такая строка не исчезает — остаётся серой подписью «без движения».

export type PaymentCountdownVisual = {
  rowBackground?: string;
  textColor?: string;
  label: string;
};

export function paymentCountdownVisual(status: CountdownStatus): PaymentCountdownVisual {
  switch (status.state) {
    case 'danger': {
      const overdue = (status.daysLeft ?? 0) < 0;
      return {
        rowBackground: 'rgba(239, 68, 68, 0.18)',
        textColor: '#b91c1c',
        label: overdue ? `Просрочка ${Math.abs(status.daysLeft ?? 0)} дн.` : `Осталось ${status.daysLeft} дн.`,
      };
    }
    case 'warning':
      return {
        rowBackground: 'rgba(250, 204, 21, 0.22)',
        textColor: '#b45309',
        label: `Осталось ${status.daysLeft} дн.`,
      };
    case 'stale':
      // Ни заливки, ни тревожного цвета: по двигателю давно ничего не делали, и красный
      // здесь обещал бы срыв срока, которого никто не срывал. Строку не прячем — её надо
      // разобрать, и вместо остатка дней она показывает, сколько стоит без работ.
      return { textColor: '#6b7280', label: `Без движения ${status.daysIdle ?? 0} дн.` };
    case 'ok':
      return { label: `Осталось ${status.daysLeft} дн.` };
    default:
      return { label: '—' };
  }
}
