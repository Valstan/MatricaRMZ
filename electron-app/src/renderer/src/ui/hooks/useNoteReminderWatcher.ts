import { useEffect, useRef } from 'react';

import { effectiveNoteReminders, normalizeNoteReminderPoints } from '@matricarmz/shared';

import type { ShellNoticeTone } from '../shell/shellNotice.js';

/**
 * Сторож напоминаний по заметкам — на уровне приложения, а не страницы.
 *
 * Почему не на странице «Заметки»: страница смонтирована только если оператор её
 * открывал (keep-alive держит вкладку живой, но не создаёт её). Напоминание,
 * которое срабатывает только на открытой вкладке, — это не напоминание, а
 * «напоминание, если оператор сидит на заметках». Здесь сторож живёт всегда, пока
 * есть вход в программу.
 *
 * Точек у заметки может быть несколько (по времени внутри дня и по дням) — срабатывает
 * каждая своя точка. Точка, которую программа пропустила (была выключена), догоняется
 * при следующем запуске в пределах CATCHUP_MS.
 *
 * Отметки о сработавших точках живут в localStorage: без них перезапуск программы
 * в пределах окна догона слал бы то же напоминание второй раз.
 */

const POLL_MS = 30_000;
const CATCHUP_MS = 24 * 60 * 60 * 1000;
/** Сколько сработавших точек держим в памяти браузера (сутки с запасом). */
const SENT_KEEP_MS = 48 * 60 * 60 * 1000;
const SENT_STORAGE_KEY = 'matrica.noteReminders.sent';

type SentMap = Record<string, number>;

function readSent(): SentMap {
  try {
    const raw = window.localStorage.getItem(SENT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: SentMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const ts = Number(value);
      if (Number.isFinite(ts) && ts > 0) out[key] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

function writeSent(sent: SentMap) {
  try {
    window.localStorage.setItem(SENT_STORAGE_KEY, JSON.stringify(sent));
  } catch {
    // Хранилище может быть недоступно (приватный режим) — тогда отметки живут
    // только в памяти вкладки, напоминание всё равно придёт.
  }
}

function formatPoint(ms: number): string {
  const value = new Date(ms);
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getDate()} ${months[value.getMonth()]} ${value.getFullYear()}, ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

export function useNoteReminderWatcher(opts: {
  meUserId: string;
  enabled: boolean;
  notify: (text: string, tone: ShellNoticeTone) => void;
}): void {
  const sentRef = useRef<SentMap | null>(null);
  const notifyRef = useRef(opts.notify);
  notifyRef.current = opts.notify;

  useEffect(() => {
    if (!opts.enabled) return;
    const me = String(opts.meUserId ?? '').trim();
    if (!me) return;
    let alive = true;

    const sent = (): SentMap => {
      if (sentRef.current === null) sentRef.current = readSent();
      return sentRef.current;
    };

    const tick = async () => {
      const result = await window.matrica.notes.list().catch(() => null);
      if (!alive || !result?.ok) return;
      const notes = Array.isArray(result.notes) ? result.notes : [];
      const now = Date.now();
      const marks = sent();
      let changed = false;

      for (const note of notes) {
        const points = normalizeNoteReminderPoints(
          note.reminders?.length ? note.reminders : effectiveNoteReminders(null, note.dueAt ?? null),
        );
        // Догоняем только точки, которые наступили недавно: забытое за месяц —
        // не напоминание, а архив.
        const due = points.filter((point) => point <= now && now - point <= CATCHUP_MS);
        if (due.length === 0) continue;
        const point = due[due.length - 1]!;
        const missed = due.length - 1;
        const stamp = `${note.id}:${point}`;
        if (marks[stamp]) continue;
        marks[stamp] = now;
        changed = true;

        const title = String(note.title ?? '').trim() || 'Заметка';
        const text =
          `Напоминание по заметке: «${title}». Срок: ${formatPoint(point)}.` +
          (missed > 0 ? ` Пропущено напоминаний: ${missed}.` : '');
        // Плашка над вкладкой — сигнал «пора посмотреть»; сообщение в чат — запись,
        // которая не потеряется, даже если оператор её не заметил.
        notifyRef.current(text, 'reminder');
        await window.matrica.chat.sendText({ recipientUserId: me, text }).catch(() => null);
      }

      if (changed) {
        const cutoff = now - SENT_KEEP_MS;
        for (const [key, ts] of Object.entries(marks)) {
          if (ts < cutoff) delete marks[key];
        }
        writeSent(marks);
      }
    };

    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [opts.enabled, opts.meUserId]);
}
