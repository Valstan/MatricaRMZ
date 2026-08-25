import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож разметки Рабочего стола.
//
// У компонента нет ни одного CSS-класса — всё инлайн, поэтому единственные стабильные
// зацепки для CDP-смоуков это `data-desktop-*`. Переименование любой из них не ломает ни
// типы, ни линт, ни один юнит-тест — ломается только приёмка Windows-клиента, и молча.
//
// Отдельно держится stopPropagation у приёмников дропа. До этапа C его не было, и это был
// не теоретический риск: корневой обработчик доигрывал поверх обработчика папки со СТАРОГО
// снимка стола, поэтому ярлык, брошенный на папку из корзины, оказывался на столе. Теперь
// полотно ещё и назначает координату — всплывший дроп папки записал бы её ярлыку в папке.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PANE = src('./DesktopPane.tsx');

describe('якоря смоуков на месте', () => {
  const ANCHORS = [
    'data-desktop-pane',
    'data-desktop-canvas',
    'data-desktop-shortcut',
    'data-desktop-selected',
    'data-desktop-folder',
    'data-desktop-folder-window',
    'data-desktop-folder-close',
    'data-desktop-trash',
    'data-desktop-lasso',
    'data-desktop-drop-marker',
    'data-desktop-upload',
  ];

  it('каждый якорь ставится компонентом', () => {
    for (const a of ANCHORS) expect(PANE, `нет якоря ${a}`).toContain(a);
  });
});

describe('приёмники дропа гасят всплытие', () => {
  it('каждый вложенный onDrop зовёт stopPropagation', () => {
    const chunks: string[] = [];
    let from = 0;
    for (;;) {
      const at = PANE.indexOf('onDrop={(e) => {', from);
      if (at < 0) break;
      chunks.push(PANE.slice(at, at + 420));
      from = at + 1;
    }
    // Папка на столе, корзина, окно открытой папки — три приёмника поверх полотна; плюс
    // сам приёмник полотна (он тоже гасит всплытие в файловой ветке).
    expect(chunks.length, 'обработчики дропа исчезли — сторож смотрит не туда').toBe(4);
    for (const c of chunks) {
      expect(c, `приёмник дропа без stopPropagation: ${c.slice(0, 120)}`).toContain('e.stopPropagation()');
    }
  });

  it('полотно отдаёт дроп ярлыка отдельной функции, а не разбирает его на месте', () => {
    expect(PANE).toContain('dropOnSurface(e)');
  });

  it('подсветка приёмника тоже гасит всплытие, иначе её перезаписывает полотно', () => {
    const at = PANE.indexOf('function allowDrop');
    expect(at).toBeGreaterThan(0);
    expect(PANE.slice(at, at + 320)).toContain('e.stopPropagation()');
  });
});

describe('раскладка считается доменом, а не вёрсткой', () => {
  it('места плиток берутся из desktopLayoutGrid', () => {
    expect(PANE).toContain('desktopLayoutGrid(');
  });

  it('размеры плитки берутся из метрик шага, а не зашиты числами', () => {
    expect(PANE).toContain('desktopTileMetrics(');
    // 92/30/11 были зашиты трижды и разъезжались между ярлыком, папкой и корзиной.
    expect(PANE).not.toContain('width: 92');
    expect(PANE).not.toContain('fontSize: 30');
  });

  it('шаг приходит снаружи — компонент не решает размер сам', () => {
    expect(PANE).toContain('stepOf?: Record<string, number>');
    expect(PANE).toContain('props.stepOf?.[shortcutId] ?? 0');
  });

  it('открытие ярлыка сообщает наверх ЕГО id — иначе счётчику нечего считать', () => {
    expect(PANE).toContain('onOpenLink: (link: unknown, shortcutId: string) => void');
    expect(PANE).not.toContain('props.onOpenLink(s.link)');
  });

  it('число колонок меряется по факту — стол резиновый', () => {
    expect(PANE).toContain('ResizeObserver');
  });
});

describe('файлы из Проводника', () => {
  it('дроп файлов ОС отличается от дропа ярлыка по типу, а не по догадке', () => {
    expect(PANE).toContain("e.dataTransfer.types.includes('Files')");
  });

  it('на планшете приём файлов не перехватывается — путей ОС там нет', () => {
    // Обе ветки (dragover и drop) обязаны спрашивать платформу: перехватить дроп и не
    // суметь его обработать хуже, чем не перехватывать вовсе.
    const branches = PANE.split("e.dataTransfer.types.includes('Files')");
    expect(branches.length - 1, 'веток приёма файлов не две — сторож смотрит не туда').toBe(2);
    for (const before of branches.slice(0, -1)) expect(before.slice(-40)).toContain('!isAndroid');
  });

  // Одна строка file_assets обслуживает всех, кто загрузил те же байты (дедуп по sha256),
  // а счётчика ссылок нет. Поэтому стол убирает СВОЙ ЯРЛЫК и никогда не трогает файл —
  // иначе «убрал с рабочего стола» выбивало бы вложение с чужой карточки.
  it('стол никогда не удаляет сам файл — только свой ярлык', () => {
    expect(PANE).not.toContain('files.delete');
    expect(PANE).toContain('файл останется');
  });

  it('плитка, которая не откроется, не кладётся на стол', () => {
    expect(PANE).toContain('up.deduped && up.canOpen === false');
  });

  it('отказ в праве загрузки объясняется, а не проглатывается', () => {
    expect(PANE).toContain('canUploadFiles === false');
  });
});
