/**
 * 試験のための、伸長しない (stored) zip を組む。WACZ を検める道 (`replay-bundle/inspect.ts`) を、本物の zip の読み手
 * (yauzl-promise) に通すため。依存に zip を書く物は無いので、ここで組む (local header・中央ディレクトリ・終わりの印)。
 *
 * 渡した順に entry を並べる。中身が空の entry (長さ 0 の索引) も組める。
 */
import { crc32 } from "node:zlib";

/** 2026-11-05 00:00 (DOS の日付と時刻)。0 だと読み手によっては日付が壊れる。 */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 5;

export const storedZip = (entries: Readonly<Record<string, string | Buffer>>): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const filename = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 伸長に要る版
    local.writeUInt16LE(0x0800, 6); // 名前は UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, filename, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // 作った版
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // 内部の属性
    central.writeUInt32LE(0, 38); // 外部の属性
    central.writeUInt32LE(offset, 42);
    centrals.push(central, filename);

    offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const count = Object.keys(entries).length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
};
