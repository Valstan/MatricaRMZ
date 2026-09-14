import { inflateRawSync } from 'node:zlib';

/**
 * Чтение архива со скриптами обслуживания — того самого, что едет с клиентом в `extraResources`
 * и закрыт паролем `111`.
 *
 * Почему свой разбор, а не библиотека и не 7-Zip:
 *  * `jszip` (он уже в зависимостях) зашифрованные записи не умеет вовсе — падает на первой же;
 *  * тащить `7za.exe` в установщик ради одной распаковки — плюс мегабайт на КАЖДУЮ машину парка
 *    и ещё один неподписанный исполняемый файл под глазами антивируса;
 *  * архив собираем мы сами (`scripts/build-kaspersky-zip.mjs`) и формат его фиксирован:
 *    ZipCrypto + deflate, размеры и CRC в центральном каталоге. Читателю не нужно быть
 *    универсальным — ему нужно быть верным ОДНОМУ формату и падать на любом другом.
 *
 * Про «самодельную криптографию»: ZipCrypto здесь не защита, а непрозрачность для сканера
 * (M94 — голый `.ps1` антивирус съедает в момент появления на диске). Пароль напечатан и в
 * памятке, и на экране. Поэтому расшифровка своими руками не создаёт риска, которого не было:
 * секрета внутри нет. Настоящая проверка целостности здесь — CRC32 распакованных данных, и она
 * же ловит неверный пароль на файлах, где совпала контрольная байта заголовка.
 */

export type ClientOpsArchiveEntry = {
  /** Имя внутри архива без ведущего каталога: `kaspersky-matrica/guide.ru.md` → `guide.ru.md`. */
  name: string;
  data: Buffer;
};

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
/** Бит 0 общего флага — запись зашифрована. */
const FLAG_ENCRYPTED = 0x1;
/** Бит 3 — размеры уехали в data descriptor ПОСЛЕ данных. Наш сборщик так не делает. */
const FLAG_DATA_DESCRIPTOR = 0x8;
/** Бит 11 — имя записи в UTF-8. Без него имя лежит в OEM-кодировке (у 7za на русской Windows — cp866). */
const FLAG_UTF8_NAME = 0x800;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * Поточный шифр ZipCrypto (PKWARE). Три ключа-состояния, по байту за раз; расшифровка и
 * шифрование отличаются только тем, какой байт скармливается обратно в состояние.
 */
class ZipCryptoKeys {
  private k0 = 0x12345678;
  private k1 = 0x23456789;
  private k2 = 0x34567890;

  constructor(password: string) {
    // Пароль наш и заведомо ASCII ('111'); latin1 не даст многобайтовой кириллице
    // разъехаться с тем, что записал 7za, если пароль однажды сменят на непечатный.
    const bytes = Buffer.from(password, 'latin1');
    for (let i = 0; i < bytes.length; i++) this.update(bytes[i]!);
  }

  private update(byte: number): void {
    this.k0 = (CRC_TABLE[(this.k0 ^ byte) & 0xff]! ^ (this.k0 >>> 8)) | 0;
    this.k1 = (this.k1 + (this.k0 & 0xff)) >>> 0;
    this.k1 = (Math.imul(this.k1, 134775813) + 1) >>> 0;
    this.k2 = (CRC_TABLE[(this.k2 ^ (this.k1 >>> 24)) & 0xff]! ^ (this.k2 >>> 8)) | 0;
  }

  private streamByte(): number {
    const temp = ((this.k2 >>> 0) | 2) & 0xffff;
    return ((temp * (temp ^ 1)) >>> 8) & 0xff;
  }

  decrypt(input: Buffer): Buffer {
    const out = Buffer.allocUnsafe(input.length);
    for (let i = 0; i < input.length; i++) {
      const plain = (input[i]! ^ this.streamByte()) & 0xff;
      this.update(plain);
      out[i] = plain;
    }
    return out;
  }
}

function decodeName(raw: Buffer, flags: number): string {
  if (flags & FLAG_UTF8_NAME) return raw.toString('utf8');
  // 7za на русской Windows пишет имена в OEM-кодировке и флаг UTF-8 не ставит: без этой ветки
  // «Запустить.cmd» приезжает кракозябрами и файл ложится на диск с нечитаемым именем.
  try {
    return new TextDecoder('ibm866').decode(raw);
  } catch {
    return raw.toString('latin1');
  }
}

function findEocd(buf: Buffer): number {
  // Комментария у нашего архива нет, но искать всё равно с конца: так читатель не зависит
  // от того, появится ли он однажды.
  const earliest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('архив повреждён: не найден конец центрального каталога (EOCD)');
}

/**
 * Разобрать архив целиком в память. Каталоги (записи с нулевым размером и именем на `/`)
 * пропускаются: снаружи нужен плоский список файлов, а не дерево.
 */
export function readClientOpsArchive(buf: Buffer, password: string): ClientOpsArchiveEntry[] {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ClientOpsArchiveEntry[] = [];

  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`архив повреждён: запись ${i + 1} без заголовка каталога`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), flags);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (flags & FLAG_DATA_DESCRIPTOR) {
      throw new Error(`«${name}»: размеры записи в data descriptor — такой архив мы не собираем`);
    }
    if (method !== 0 && method !== 8) throw new Error(`«${name}»: неизвестный метод сжатия ${method}`);

    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error(`«${name}»: битый локальный заголовок`);
    // Длины имени и extra в локальном заголовке СВОИ и с каталогом не обязаны совпадать —
    // смещение данных считается только по ним.
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    let payload = buf.subarray(dataStart, dataStart + compressedSize);

    if (flags & FLAG_ENCRYPTED) {
      const keys = new ZipCryptoKeys(password);
      const header = keys.decrypt(payload.subarray(0, 12));
      // Последний байт двенадцатибайтового заголовка — старший байт CRC. Проверка слабая
      // (1 из 256 неверных паролей её проходит), настоящая — CRC32 ниже.
      if (header[11] !== ((crc >>> 24) & 0xff)) throw new Error(`«${name}»: неверный пароль архива`);
      payload = keys.decrypt(payload.subarray(12));
    }

    const data = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    if (data.length !== uncompressedSize) {
      throw new Error(`«${name}»: размер после распаковки ${data.length}, ожидался ${uncompressedSize}`);
    }
    if (crc32(data) !== crc) throw new Error(`«${name}»: не сошлась контрольная сумма (неверный пароль или битый архив)`);

    // Ведущий каталог архива снимаем здесь, а не у вызывающего: снаружи ни имя каталога,
    // ни само его наличие не должны быть известны.
    const slash = name.lastIndexOf('/');
    out.push({ name: slash >= 0 ? name.slice(slash + 1) : name, data });
  }

  return out;
}
