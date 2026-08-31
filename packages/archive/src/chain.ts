import {
  hashLeaf,
  hex,
  inclusionPath,
  merkleRoot,
  unhex,
  verifyInclusion,
} from "./merkle.js";

/** One archived document, as it enters the day's tree. */
export interface ArchiveEntry {
  documentId: string;
  tenantId: string;
  /** SHA-256 of the raw bytes, hex. This is what ties the proof to the file. */
  sha256: string;
  sizeBytes: number;
  /** ISO 8601 instant the document was written to the archive. */
  archivedAt: string;
}

/** Mirrors one `archive_chain` row. */
export interface ChainLink {
  /** YYYY-MM-DD, the sealed day. */
  day: string;
  tenantId: string;
  merkleRoot: string;
  /** Previous day's merkleRoot. Null only for a tenant's first sealed day. */
  prevRoot: string | null;
  treeSize: number;
  sealedAt: string;
}

export interface InclusionProof {
  documentId: string;
  tenantId: string;
  day: string;
  leafHash: string;
  index: number;
  treeSize: number;
  path: string[];
  merkleRoot: string;
}

const UNIT = "\u001f";

/**
 * Canonical bytes for one entry.
 *
 * Field order is written out rather than derived from an object, and the
 * separator is a control character that cannot occur in any of the values. This
 * has to reproduce byte-for-byte in 2033: `JSON.stringify` would tie the hash
 * to whatever key order the object happened to have, which is not a property
 * worth betting a ten-year audit trail on.
 */
export function canonicalEntry(entry: ArchiveEntry): Buffer {
  const fields = [
    "belegbox.archive.v1",
    entry.tenantId,
    entry.documentId,
    entry.sha256.toLowerCase(),
    String(entry.sizeBytes),
    entry.archivedAt,
  ];

  for (const f of fields) {
    if (f.includes(UNIT)) {
      throw new Error("Archive entry field contains the unit separator.");
    }
  }
  return Buffer.from(fields.join(UNIT), "utf8");
}

export function entryLeafHash(entry: ArchiveEntry): Buffer {
  return hashLeaf(canonicalEntry(entry));
}

/**
 * Orders a day's entries deterministically.
 *
 * Two runs over the same day must build the same tree, so ordering cannot
 * depend on the sequence rows came back in. `archivedAt` then `documentId`
 * gives a total order.
 */
export function orderEntries(entries: ArchiveEntry[]): ArchiveEntry[] {
  return [...entries].sort(
    (a, b) =>
      a.archivedAt.localeCompare(b.archivedAt) || a.documentId.localeCompare(b.documentId),
  );
}

export interface SealInput {
  day: string;
  tenantId: string;
  entries: ArchiveEntry[];
  /** Previous day's root for this tenant, or null for the first day. */
  prevRoot: string | null;
  sealedAt?: string;
}

/**
 * Seals one tenant-day into a chain link.
 *
 * A day with no documents still seals, to an empty-tree root. Gaps in the chain
 * are indistinguishable from deletions, and GoBD Vollständigkeit is exactly the
 * property being demonstrated here.
 */
export function sealDay(input: SealInput): { link: ChainLink; ordered: ArchiveEntry[] } {
  const ordered = orderEntries(input.entries);
  const leaves = ordered.map(entryLeafHash);

  return {
    ordered,
    link: {
      day: input.day,
      tenantId: input.tenantId,
      merkleRoot: hex(merkleRoot(leaves)),
      prevRoot: input.prevRoot,
      treeSize: leaves.length,
      sealedAt: input.sealedAt ?? new Date().toISOString(),
    },
  };
}

/** Builds the proof that one document sat in a sealed day. */
export function proveInclusion(
  entries: ArchiveEntry[],
  documentId: string,
  link: ChainLink,
): InclusionProof {
  const ordered = orderEntries(entries);
  const index = ordered.findIndex((e) => e.documentId === documentId);
  if (index < 0) {
    throw new Error(`Document ${documentId} is not in the entries for ${link.day}.`);
  }

  const leaves = ordered.map(entryLeafHash);
  const computed = hex(merkleRoot(leaves));
  if (computed !== link.merkleRoot) {
    // The stored root and the recomputed root disagree: either the entries or
    // the seal changed. Refusing to emit a proof is the only safe answer.
    throw new Error(
      `Recomputed root for ${link.day} does not match the sealed root. Archive integrity is in question.`,
    );
  }

  return {
    documentId,
    tenantId: link.tenantId,
    day: link.day,
    leafHash: hex(leaves[index] as Buffer),
    index,
    treeSize: leaves.length,
    path: inclusionPath(index, leaves).map(hex),
    merkleRoot: link.merkleRoot,
  };
}

/** Checks a proof against an entry, using only the proof and the entry. */
export function verifyEntryProof(entry: ArchiveEntry, proof: InclusionProof): boolean {
  const leafHash = entryLeafHash(entry);
  if (hex(leafHash) !== proof.leafHash) return false;

  return verifyInclusion(
    leafHash,
    proof.index,
    proof.treeSize,
    proof.path.map(unhex),
    unhex(proof.merkleRoot),
  );
}

export type ChainProblem =
  | { code: "out_of_order"; day: string; message: string }
  | { code: "broken_link"; day: string; message: string }
  | { code: "mixed_tenant"; day: string; message: string };

/**
 * Walks a tenant's chain links in order.
 *
 * Each day names the previous day's root, so altering any past day's tree
 * invalidates that day and every day after it. Detecting the break is the
 * point: the archive cannot prevent a determined operator from editing a row,
 * but it can make the edit impossible to hide.
 */
export function verifyChain(links: ChainLink[]): { valid: boolean; problems: ChainProblem[] } {
  const problems: ChainProblem[] = [];
  const ordered = [...links].sort((a, b) => a.day.localeCompare(b.day));

  let previous: ChainLink | undefined;
  for (const link of ordered) {
    if (previous) {
      if (link.day <= previous.day) {
        problems.push({
          code: "out_of_order",
          day: link.day,
          message: `${link.day} does not come after ${previous.day}.`,
        });
      }
      if (link.tenantId !== previous.tenantId) {
        problems.push({
          code: "mixed_tenant",
          day: link.day,
          message: "Chain contains links from more than one tenant.",
        });
      }
      if (link.prevRoot !== previous.merkleRoot) {
        problems.push({
          code: "broken_link",
          day: link.day,
          message: `${link.day} points at ${link.prevRoot ?? "null"}, but ${previous.day} sealed to ${previous.merkleRoot}.`,
        });
      }
    } else if (link.prevRoot !== null) {
      problems.push({
        code: "broken_link",
        day: link.day,
        message: "First link in the chain must have a null previous root.",
      });
    }
    previous = link;
  }

  return { valid: problems.length === 0, problems };
}
