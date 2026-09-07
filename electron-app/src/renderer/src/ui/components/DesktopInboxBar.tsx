import React, { useMemo } from 'react';

import type { DesktopInboxItem } from '@matricarmz/shared';

import { Button } from './Button.js';

/**
 * Полоса входящих файлов над Верстаком: «Принять N файлов от такого-то».
 *
 * Согласие обязательно, и не из вежливости: без него любой коллега (а на общем экране — любой,
 * кто дорвался до чужой учётки) заваливал бы чужой Верстак плитками, а убирать их пришлось бы
 * руками по одной. Пока не принято, файл лежит только в чате отправителя и получателя.
 *
 * Отклонение не удаляет ни файл, ни сообщение — оно лишь снимает предложение с Верстака:
 * удалять чужое отправленное мы не вправе, а сообщение остаётся в переписке как след.
 */
export function DesktopInboxBar(props: {
  items: DesktopInboxItem[];
  onAccept: (items: DesktopInboxItem[]) => void;
  onDecline: (items: DesktopInboxItem[]) => void;
}) {
  const bySender = useMemo(() => {
    const map = new Map<string, DesktopInboxItem[]>();
    for (const item of props.items) {
      const key = item.senderUserId || item.senderUsername;
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    return Array.from(map.values());
  }, [props.items]);

  if (bySender.length === 0) return null;

  return (
    <div data-desktop-inbox style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
      {bySender.map((group) => {
        const first = group[0];
        if (!first) return null;
        const who = first.senderUsername || 'коллеги';
        const names = group.map((x) => x.fileName).join(', ');
        return (
          <div
            key={first.senderUserId || first.senderUsername}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              padding: '8px 10px',
              border: '1px solid var(--border)',
              borderRadius: 10,
              background: 'var(--surface-2)',
            }}
          >
            <span style={{ fontWeight: 600 }}>
              📥 {group.length === 1 ? 'Файл' : `Файлов: ${group.length}`} от {who}
            </span>
            <span className="ui-muted" title={names} style={{ flex: 1, minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {names}
            </span>
            <Button onClick={() => props.onAccept(group)}>
              {group.length === 1 ? 'Принять на Верстак' : `Принять ${group.length} на Верстак`}
            </Button>
            <Button variant="ghost" onClick={() => props.onDecline(group)}>
              Отклонить
            </Button>
          </div>
        );
      })}
    </div>
  );
}
