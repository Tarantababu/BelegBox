import { createHash } from "node:crypto";
import { buildManifest, MANIFEST_NAME, type ManifestRow } from "./manifest.js";
import { entryName } from "./names.js";
import {
  BundleError,
  type BelegSource,
  type BundleResult,
  type IncludedBeleg,
  type SkippedBeleg,
} from "./types.js";
import { buildZip, type ZipEntry } from "./zip.js";

/**
 * Assembles the bundle of originals.
 *
 * Reads bytes through a port rather than a store: the package stays free of a
 * storage dependency, and a test can hand it a corrupted object to prove the
 * integrity check bites.
 */
export interface ObjectReader {
  get(key: string): Promise<Buffer>;
}

export interface BundleInput {
  tenantName: string;
  from: string;
  to: string;
  documents: BelegSource[];
  generatedAt?: Date;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A filename the recipient can file without renaming.
 *
 * Slug rather than the tenant's legal name verbatim: this lands in a downloads
 * folder on someone else's machine.
 */
export function bundleFilename(tenantName: string, from: string, to: string): string {
  const slug = tenantName
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "Belege";

  return `Belege_${slug}_${from.replace(/-/g, "")}-${to.replace(/-/g, "")}.zip`;
}

/**
 * Builds the ZIP.
 *
 * The integrity check is the part worth being deliberate about. Every object is
 * hashed on the way out and compared with the digest recorded when it was
 * archived. A mismatch means the bytes in storage are not the bytes that were
 * archived, and the document is left out and named in the manifest rather than
 * shipped as an original it is not. That makes this export an audit of the
 * archive as well as a hand-over - the only time the whole period is read back
 * and checked.
 */
export async function buildBelegBundle(
  reader: ObjectReader,
  input: BundleInput,
): Promise<BundleResult> {
  const generatedAt = input.generatedAt ?? new Date();

  if (input.documents.length === 0) {
    throw new BundleError("Für diesen Zeitraum gibt es keine Belege.");
  }

  const taken = new Set<string>([MANIFEST_NAME]);
  const entries: ZipEntry[] = [];
  const rows: ManifestRow[] = [];
  const included: IncludedBeleg[] = [];
  const skipped: SkippedBeleg[] = [];

  for (const source of input.documents) {
    let bytes: Buffer;
    try {
      bytes = await reader.get(source.rawObjectKey);
    } catch (cause) {
      const reason = (cause as { name?: string }).name === "NoSuchKey"
        ? "not_in_storage"
        : "read_failed";
      const skip: SkippedBeleg = {
        documentId: source.id,
        invoiceNumber: source.invoiceNumber,
        supplierName: source.supplierName,
        reason,
      };
      skipped.push(skip);
      rows.push({ source, skip });
      continue;
    }

    const actual = sha256(bytes);
    if (actual !== source.rawSha256) {
      const skip: SkippedBeleg = {
        documentId: source.id,
        invoiceNumber: source.invoiceNumber,
        supplierName: source.supplierName,
        reason: "hash_mismatch",
        expectedSha256: source.rawSha256,
        actualSha256: actual,
      };
      skipped.push(skip);
      rows.push({ source, skip });
      continue;
    }

    const name = entryName(
      {
        issuedAt: source.issuedAt,
        invoiceNumber: source.invoiceNumber,
        supplierName: source.supplierName,
        format: source.format,
        contentType: source.contentType,
        bytes,
        documentId: source.id,
      },
      taken,
    );

    // The archived bytes, untouched. Timestamped with when the document was
    // received, not with when the bundle was made, so the folder listing
    // carries the same dates as the archive.
    entries.push({ name, bytes, modifiedAt: source.receivedAt });
    included.push({ documentId: source.id, entryName: name, sha256: actual, sizeBytes: bytes.length });
    rows.push({ source, entryName: name });
  }

  const manifest = buildManifest(
    { tenantName: input.tenantName, from: input.from, to: input.to, generatedAt },
    rows,
  );
  // First in the archive, so it is the first thing listed when the ZIP is
  // opened rather than something to scroll for.
  entries.unshift({ name: MANIFEST_NAME, bytes: manifest, modifiedAt: generatedAt });

  const bytes = buildZip(entries, generatedAt);

  return {
    filename: bundleFilename(input.tenantName, input.from, input.to),
    bytes,
    included,
    skipped,
    sha256: sha256(bytes),
  };
}
