import { crc32, deflateRawSync } from "node:zlib";

/**
 * A minimal ZIP writer.
 *
 * Written rather than pulled in, for the same reason the EXTF writer and the
 * Merkle tree are: this produces an artefact a Steuerberater and possibly a
 * Betriebsprüfer opens, the format is small and fully specified, and a
 * dependency here would be one more thing to trust with the bytes of an
 * archived original.
 *
 * Deliberately not supported: Zip64, encryption, and multi-disk. A bundle that
 * would need Zip64 is refused with a message that says so, rather than emitting
 * an archive that opens on some tools and not others.
 */

/** Deflate is the only method every reader supports besides store. */
const METHOD_DEFLATE = 8;
const METHOD_STORE = 0;

/** Bit 11: filenames and comments are UTF-8. */
const FLAG_UTF8 = 0x0800;

const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  /** Forward slashes only; the writer refuses anything that escapes the root. */
  name: string;
  bytes: Buffer;
  /** Defaults to the bundle's timestamp. */
  modifiedAt?: Date;
}

/**
 * MS-DOS timestamp, two-second resolution, no timezone.
 *
 * The format has carried this since 1980 and every reader expects it. The
 * fields mean local time; the value is taken in UTC and the manifest says so,
 * rather than being silently shifted into whatever zone the server sits in.
 */
function dosDateTime(at: Date): { time: number; date: number } {
  const year = at.getUTCFullYear();
  if (year < 1980) {
    // The epoch the format cannot express. Clamped rather than wrapped, which
    // is what produces 2076 timestamps in other people's archives.
    return { time: 0, date: (1 << 5) | 1 };
  }
  return {
    time:
      (at.getUTCHours() << 11) |
      (at.getUTCMinutes() << 5) |
      Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

/**
 * Refuses a name that would write outside the extraction directory.
 *
 * Zip Slip. Entry names here derive from supplier-controlled data that arrived
 * by email, and an archive that writes `../../.ssh/authorized_keys` on
 * extraction is why this check lives in the writer rather than being left to
 * whoever assembles the entry list.
 */
function assertSafeName(name: string): void {
  if (!name) throw new ZipError("An entry needs a name.");
  if (name.length > 200) throw new ZipError(`Entry name is too long: ${name.slice(0, 40)}...`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new ZipError(`Entry name must be relative: ${name}`);
  }
  if (name.includes("\\")) throw new ZipError(`Entry name must use forward slashes: ${name}`);
  if (name.split("/").some((part) => part === ".." || part === "" || part === ".")) {
    throw new ZipError(`Entry name must not escape the archive root: ${name}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new ZipError("Entry name contains control characters.");
  }
}

interface Placed {
  name: Buffer;
  crc: number;
  compressedSize: number;
  size: number;
  method: number;
  offset: number;
  time: number;
  date: number;
}

export function buildZip(entries: ZipEntry[], defaultModifiedAt: Date): Buffer {
  if (entries.length > MAX_ENTRIES) {
    throw new ZipError(
      `${entries.length} entries; this writer emits at most ${MAX_ENTRIES}. Export a shorter period.`,
    );
  }

  const seen = new Set<string>();
  const parts: Buffer[] = [];
  const placed: Placed[] = [];
  let offset = 0;

  for (const entry of entries) {
    assertSafeName(entry.name);
    if (seen.has(entry.name)) {
      // Two files under one name means one of them is unreachable after
      // extraction, and which one depends on the tool.
      throw new ZipError(`Duplicate entry name: ${entry.name}`);
    }
    seen.add(entry.name);

    const name = Buffer.from(entry.name, "utf8");
    const size = entry.bytes.length;

    const deflated = deflateRawSync(entry.bytes, { level: 9 });
    // An already-compressed original - a ZUGFeRD PDF - can come out larger.
    const useDeflate = deflated.length < size;
    const payload = useDeflate ? deflated : entry.bytes;

    if (size > MAX_SIZE || payload.length > MAX_SIZE) {
      throw new ZipError(`"${entry.name}" is larger than 4 GiB; Zip64 is not supported.`);
    }

    const { time, date } = dosDateTime(entry.modifiedAt ?? defaultModifiedAt);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_SIG, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(FLAG_UTF8, 6);
    header.writeUInt16LE(useDeflate ? METHOD_DEFLATE : METHOD_STORE, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    const checksum = crc32(entry.bytes);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);

    parts.push(header, name, payload);
    placed.push({
      name,
      crc: checksum,
      compressedSize: payload.length,
      size,
      method: useDeflate ? METHOD_DEFLATE : METHOD_STORE,
      offset,
      time,
      date,
    });
    offset += header.length + name.length + payload.length;

    if (offset > MAX_SIZE) {
      throw new ZipError(
        "The bundle exceeds 4 GiB; Zip64 is not supported. Export a shorter period.",
      );
    }
  }

  const centralStart = offset;
  const central: Buffer[] = [];

  for (const item of placed) {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(CENTRAL_SIG, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(FLAG_UTF8, 8);
    record.writeUInt16LE(item.method, 10);
    record.writeUInt16LE(item.time, 12);
    record.writeUInt16LE(item.date, 14);
    record.writeUInt32LE(item.crc, 16);
    record.writeUInt32LE(item.compressedSize, 20);
    record.writeUInt32LE(item.size, 24);
    record.writeUInt16LE(item.name.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    // 0644, regular file. Some extractors otherwise produce unreadable files.
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    record.writeUInt32LE(item.offset, 42);

    central.push(record, item.name);
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(placed.length, 8);
  eocd.writeUInt16LE(placed.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, ...central, eocd]);
}
