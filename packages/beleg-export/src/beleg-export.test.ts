import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildBelegBundle,
  buildZip,
  bundleFilename,
  entryName,
  extensionFor,
  MANIFEST_NAME,
  ZipError,
  BundleError,
  type BelegSource,
  type ObjectReader,
} from "./index.js";

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const XML = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><Invoice><ID>KRB-3390</ID></Invoice>',
  "utf8",
);
const PDF = Buffer.from("%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\nZUGFeRD", "binary");

const AT = new Date("2026-09-01T10:30:00Z");

function source(over: Partial<BelegSource> = {}): BelegSource {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    rawObjectKey: "ab/one",
    rawSha256: sha(XML),
    sizeBytes: XML.length,
    supplierName: "Kaffee Röster Baden GmbH",
    invoiceNumber: "KRB-3390",
    issuedAt: "2026-08-19",
    totalGross: "201.42",
    status: "clean",
    format: "xrechnung_ubl",
    contentType: "application/xml",
    receivedAt: new Date("2026-08-19T08:00:00Z"),
    archiveDay: "2026-08-19",
    merkleRoot: "b9".padEnd(64, "0"),
    ...over,
  };
}

/** A store that hands back exactly what it was given. */
function reader(objects: Record<string, Buffer>): ObjectReader {
  return {
    async get(key) {
      const bytes = objects[key];
      if (!bytes) {
        const error = new Error(`no such key ${key}`);
        error.name = "NoSuchKey";
        throw error;
      }
      return bytes;
    },
  };
}

/**
 * A reader good enough to assert on the archive we produce.
 *
 * Parsing our own output with our own writer would prove nothing, so this walks
 * the central directory the way an extractor does - which is also what catches
 * a wrong offset, the classic way a hand-written ZIP opens in one tool and not
 * another.
 */
function readZip(zip: Buffer): Map<string, { compressed: Buffer; method: number; crc: number; size: number }> {
  const eocdOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocdOffset).toBeGreaterThan(-1);

  const count = zip.readUInt16LE(eocdOffset + 10);
  let cursor = zip.readUInt32LE(eocdOffset + 16);
  const out = new Map<string, { compressed: Buffer; method: number; crc: number; size: number }>();

  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    out.set(name, {
      compressed: zip.subarray(dataStart, dataStart + compressedSize),
      method,
      crc,
      size,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

async function inflate(entry: { compressed: Buffer; method: number }): Promise<Buffer> {
  if (entry.method === 0) return entry.compressed;
  const { inflateRawSync } = await import("node:zlib");
  return inflateRawSync(entry.compressed);
}

describe("the zip writer", () => {
  it("produces an archive that walks from its own central directory", () => {
    const zip = buildZip(
      [
        { name: "a.xml", bytes: XML },
        { name: "b.pdf", bytes: PDF },
      ],
      AT,
    );
    const entries = readZip(zip);
    expect([...entries.keys()]).toEqual(["a.xml", "b.pdf"]);
  });

  it("returns the bytes it was given, unchanged", async () => {
    const zip = buildZip([{ name: "a.xml", bytes: XML }], AT);
    const entry = readZip(zip).get("a.xml");
    expect(await inflate(entry!)).toEqual(XML);
  });

  it("stores rather than deflates when compression would grow the file", () => {
    // A ZUGFeRD PDF is already compressed. Deflating it again costs bytes.
    // Genuinely random: an arithmetic sequence still has structure deflate
    // finds, which is what made the first version of this test wrong.
    const incompressible = randomBytes(512);
    const zip = buildZip([{ name: "x.pdf", bytes: incompressible }], AT);
    expect(readZip(zip).get("x.pdf")?.method).toBe(0);
  });

  it.each([
    "../escape.xml",
    "a/../../escape.xml",
    "/absolute.xml",
    "C:/windows.xml",
    "back\\slash.xml",
  ])("refuses %s", (name) => {
    // Zip Slip. Entry names derive from supplier-controlled data.
    expect(() => buildZip([{ name, bytes: XML }], AT)).toThrow(ZipError);
  });

  it("refuses a control character in a name", () => {
    expect(() => buildZip([{ name: "a\u0000b.xml", bytes: XML }], AT)).toThrow(ZipError);
  });

  it("refuses two entries under one name", () => {
    // One of them would be unreachable, and which one depends on the extractor.
    expect(() =>
      buildZip([{ name: "a.xml", bytes: XML }, { name: "a.xml", bytes: PDF }], AT),
    ).toThrow(ZipError);
  });

  it("marks names as UTF-8", () => {
    const zip = buildZip([{ name: "a.xml", bytes: XML }], AT);
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0x0800);
  });

  it("clamps a pre-1980 timestamp rather than wrapping it", () => {
    // The format cannot express it; wrapping is what puts 2076 in an archive.
    const zip = buildZip([{ name: "a.xml", bytes: XML, modifiedAt: new Date("1970-01-01") }], AT);
    expect(zip.readUInt16LE(12)).toBe((1 << 5) | 1);
  });
});

describe("naming a file in the bundle", () => {
  it("carries the date, the invoice number and the supplier", () => {
    const name = entryName(
      {
        issuedAt: "2026-08-19",
        invoiceNumber: "KRB-3390",
        supplierName: "Kaffee Röster Baden GmbH",
        format: "xrechnung_ubl",
        contentType: "application/xml",
        documentId: "abc",
      },
      new Set(),
    );
    // Belegfeld 1 in the Buchungsstapel is the invoice number; this is how a
    // person matches a posting to a file.
    expect(name).toBe("2026-08-19_KRB-3390_Kaffee-Roester-Baden-GmbH.xml");
  });

  it("transliterates the German way", () => {
    const name = entryName(
      {
        issuedAt: "2026-01-01",
        invoiceNumber: "1",
        supplierName: "Şahin Döner GmbH",
        format: "xrechnung_cii",
        contentType: null,
        documentId: "abc",
      },
      new Set(),
    );
    expect(name).toBe("2026-01-01_1_Sahin-Doener-GmbH.xml");
  });

  it("resolves a repeated invoice number instead of losing a file", () => {
    const taken = new Set<string>();
    const input = {
      issuedAt: "2026-08-19",
      invoiceNumber: "RE-1",
      supplierName: "Test GmbH",
      format: "xrechnung_ubl",
      contentType: null,
      documentId: "abc",
    };
    expect(entryName(input, taken)).toBe("2026-08-19_RE-1_Test-GmbH.xml");
    expect(entryName(input, taken)).toBe("2026-08-19_RE-1_Test-GmbH_2.xml");
  });

  it("falls back to the document id when there is nothing to name it after", () => {
    const name = entryName(
      {
        issuedAt: null,
        invoiceNumber: null,
        supplierName: null,
        format: null,
        contentType: null,
        documentId: "deadbeef-1111",
      },
      new Set(),
    );
    expect(name).toBe("ohne-datum_deadbeef.bin");
  });

  it("takes the extension from what the document is", () => {
    // Never from documents.filename: that is whatever an email attachment was
    // called, and a supplier does not get to decide an original ends in .exe.
    expect(extensionFor("zugferd", "application/pdf")).toBe("pdf");
    expect(extensionFor("xrechnung_ubl", "application/xml")).toBe("xml");
    expect(extensionFor("other", null)).toBe("bin");
  });

  it("believes the bytes over the metadata", () => {
    // A document recorded as ZUGFeRD whose archived object is the bare XML.
    // Naming that ".pdf" hands the recipient a file their reader refuses.
    expect(extensionFor("zugferd", "application/pdf", XML)).toBe("xml");
    expect(extensionFor("xrechnung_ubl", "application/xml", PDF)).toBe("pdf");
  });

  it("strips a leading dot so nothing lands hidden", () => {
    const name = entryName(
      {
        issuedAt: "2026-01-01",
        invoiceNumber: "..hidden",
        supplierName: null,
        format: "xrechnung_ubl",
        contentType: null,
        documentId: "abc",
      },
      new Set(),
    );
    expect(name).toBe("2026-01-01_hidden.xml");
  });
});

describe("the bundle", () => {
  const store = reader({ "ab/one": XML });

  it("carries the originals and a manifest", async () => {
    const result = await buildBelegBundle(store, {
      tenantName: "Şahin Döner GmbH",
      from: "2026-08-01",
      to: "2026-08-31",
      documents: [source()],
      generatedAt: AT,
    });

    const entries = readZip(result.bytes);
    expect([...entries.keys()]).toEqual([
      MANIFEST_NAME,
      "2026-08-19_KRB-3390_Kaffee-Roester-Baden-GmbH.xml",
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.included).toHaveLength(1);
  });

  it("hands over the archived bytes untouched", async () => {
    // The whole point. Not re-serialised, not re-encoded, not regenerated from
    // the parsed model.
    const result = await buildBelegBundle(store, {
      tenantName: "T",
      from: "2026-08-01",
      to: "2026-08-31",
      documents: [source()],
      generatedAt: AT,
    });
    const entry = readZip(result.bytes).get("2026-08-19_KRB-3390_Kaffee-Roester-Baden-GmbH.xml");
    expect(await inflate(entry!)).toEqual(XML);
  });

  describe("when the archive does not agree with itself", () => {
    it("leaves out a document whose bytes no longer match their digest", async () => {
      // Corruption or tampering. Shipping these bytes would pass them off as an
      // original they are not.
      const tampered = Buffer.from(XML.toString("utf8").replace("KRB-3390", "KRB-9999"));
      const result = await buildBelegBundle(reader({ "ab/one": tampered }), {
        tenantName: "T",
        from: "2026-08-01",
        to: "2026-08-31",
        documents: [source()],
        generatedAt: AT,
      });

      expect(result.included).toEqual([]);
      expect(result.skipped[0]?.reason).toBe("hash_mismatch");
      expect(result.skipped[0]?.expectedSha256).toBe(sha(XML));
      expect(result.skipped[0]?.actualSha256).toBe(sha(tampered));
      expect([...readZip(result.bytes).keys()]).toEqual([MANIFEST_NAME]);
    });

    it("says so in the manifest rather than shipping a short bundle in silence", async () => {
      const tampered = Buffer.from("something else entirely");
      const result = await buildBelegBundle(reader({ "ab/one": tampered }), {
        tenantName: "T",
        from: "2026-08-01",
        to: "2026-08-31",
        documents: [source()],
        generatedAt: AT,
      });

      const manifest = await inflate(readZip(result.bytes).get(MANIFEST_NAME)!);
      const text = manifest.toString("latin1");
      expect(text).toContain("KRB-3390");
      expect(text).toContain("nein");
      expect(text).toContain("Prüfsumme");
    });

    it("reports a missing object without failing the whole export", async () => {
      const result = await buildBelegBundle(reader({}), {
        tenantName: "T",
        from: "2026-08-01",
        to: "2026-08-31",
        documents: [source()],
        generatedAt: AT,
      });
      expect(result.skipped[0]?.reason).toBe("not_in_storage");
    });
  });

  describe("the manifest", () => {
    it("has a row for every document in the period, included or not", async () => {
      const present = source();
      const missing = source({ id: "22222222-0000-0000-0000-000000000000", rawObjectKey: "zz/gone", invoiceNumber: "GONE-1" });

      const result = await buildBelegBundle(store, {
        tenantName: "T",
        from: "2026-08-01",
        to: "2026-08-31",
        documents: [present, missing],
        generatedAt: AT,
      });

      const text = (await inflate(readZip(result.bytes).get(MANIFEST_NAME)!)).toString("latin1");
      expect(text).toContain("KRB-3390");
      expect(text).toContain("GONE-1");
    });

    it("is Windows-1252 with CRLF, like the Buchungsstapel beside it", async () => {
      const result = await buildBelegBundle(store, {
        tenantName: "T",
        from: "2026-08-01",
        to: "2026-08-31",
        documents: [source({ supplierName: "Getränke Müller GmbH" })],
        generatedAt: AT,
      });

      const manifest = await inflate(readZip(result.bytes).get(MANIFEST_NAME)!);
      // Single-byte umlauts, not the two bytes UTF-8 would use.
      expect(manifest.includes(Buffer.from([0xe4]))).toBe(true);
      expect(manifest.includes(Buffer.from("\r\n"))).toBe(true);
    });

    it("carries the archive day and its Merkle root, so inclusion stays checkable", async () => {
      const result = await buildBelegBundle(store, {
        tenantName: "T",
        from: "2026-08-01",
        to: "2026-08-31",
        documents: [source()],
        generatedAt: AT,
      });
      const text = (await inflate(readZip(result.bytes).get(MANIFEST_NAME)!)).toString("latin1");
      expect(text).toContain("b9".padEnd(64, "0"));
      expect(text).toContain("19.08.2026");
    });
  });

  it("names the file so it can be filed without renaming", () => {
    expect(bundleFilename("Şahin Döner GmbH", "2026-08-01", "2026-08-31")).toBe(
      "Belege_Sahin-Doener-GmbH_20260801-20260831.zip",
    );
  });

  it("produces the same bytes for the same input", async () => {
    const input = {
      tenantName: "T",
      from: "2026-08-01",
      to: "2026-08-31",
      documents: [source()],
      generatedAt: AT,
    };
    const first = await buildBelegBundle(store, input);
    const second = await buildBelegBundle(store, input);
    expect(first.sha256).toBe(second.sha256);
  });

  it("refuses an empty period rather than handing over an empty folder", async () => {
    await expect(
      buildBelegBundle(store, { tenantName: "T", from: "2026-08-01", to: "2026-08-31", documents: [] }),
    ).rejects.toThrow(BundleError);
  });
});
