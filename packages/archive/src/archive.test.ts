import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalEntry,
  entryLeafHash,
  orderEntries,
  proveInclusion,
  sealDay,
  verifyChain,
  verifyEntryProof,
  type ArchiveEntry,
  type ChainLink,
} from "./chain.js";
import {
  hashLeaf,
  hashNode,
  hex,
  inclusionPath,
  merkleRoot,
  unhex,
  verifyInclusion,
} from "./merkle.js";

const leaves = (n: number): Buffer[] =>
  Array.from({ length: n }, (_, i) => hashLeaf(Buffer.from(`doc-${i}`)));

function entry(over: Partial<ArchiveEntry> = {}): ArchiveEntry {
  return {
    documentId: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    sha256: "a".repeat(64),
    sizeBytes: 4096,
    archivedAt: "2026-08-27T09:14:00.000Z",
    ...over,
  };
}

describe("merkle tree", () => {
  it("hashes the empty tree to SHA-256 of nothing (RFC 6962)", () => {
    expect(hex(merkleRoot([]))).toBe(createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  });

  it("returns the leaf itself as the root of a single-leaf tree", () => {
    const l = leaves(1);
    expect(merkleRoot(l).equals(l[0] as Buffer)).toBe(true);
  });

  it("builds a two-leaf root as hashNode(l0, l1)", () => {
    const l = leaves(2);
    expect(merkleRoot(l).equals(hashNode(l[0] as Buffer, l[1] as Buffer))).toBe(true);
  });

  // Domain separation. Without the 0x00/0x01 prefixes an internal node could be
  // presented as a leaf - the second-preimage attack RFC 6962 exists to close.
  it("separates leaf and node hashes", () => {
    const data = Buffer.from("same bytes");
    expect(hashLeaf(data).equals(hashNode(data, Buffer.alloc(0)))).toBe(false);
  });

  // CVE-2012-2459: duplicating the last node to pad lets two different leaf
  // sets produce one root. Splitting at the largest power of two does not.
  it("does not collide a 3-leaf tree with its duplicate-padded 4-leaf form", () => {
    const three = leaves(3);
    const padded = [...three, three[2] as Buffer];
    expect(hex(merkleRoot(three))).not.toBe(hex(merkleRoot(padded)));
  });

  it("changes the root when any leaf changes", () => {
    const l = leaves(8);
    const before = hex(merkleRoot(l));
    l[5] = hashLeaf(Buffer.from("tampered"));
    expect(hex(merkleRoot(l))).not.toBe(before);
  });

  it("verifies every leaf of every tree size up to 33", () => {
    for (let size = 1; size <= 33; size++) {
      const l = leaves(size);
      const root = merkleRoot(l);
      for (let i = 0; i < size; i++) {
        const path = inclusionPath(i, l);
        expect(
          verifyInclusion(l[i] as Buffer, i, size, path, root),
          `size ${size}, index ${i}`,
        ).toBe(true);
      }
    }
  });

  it("rejects a proof for the wrong leaf", () => {
    const l = leaves(9);
    const root = merkleRoot(l);
    const path = inclusionPath(3, l);
    expect(verifyInclusion(hashLeaf(Buffer.from("forged")), 3, 9, path, root)).toBe(false);
  });

  it("rejects a proof replayed at the wrong index", () => {
    const l = leaves(9);
    const root = merkleRoot(l);
    const path = inclusionPath(3, l);
    expect(verifyInclusion(l[3] as Buffer, 4, 9, path, root)).toBe(false);
  });

  it("rejects a tampered path element", () => {
    const l = leaves(16);
    const root = merkleRoot(l);
    const path = inclusionPath(7, l);
    path[1] = hashLeaf(Buffer.from("swapped"));
    expect(verifyInclusion(l[7] as Buffer, 7, 16, path, root)).toBe(false);
  });

  it("rejects a path with elements removed or added", () => {
    const l = leaves(16);
    const root = merkleRoot(l);
    const path = inclusionPath(7, l);
    expect(verifyInclusion(l[7] as Buffer, 7, 16, path.slice(1), root)).toBe(false);
    expect(
      verifyInclusion(l[7] as Buffer, 7, 16, [...path, hashLeaf(Buffer.from("x"))], root),
    ).toBe(false);
  });

  it("rejects an out-of-range index", () => {
    const l = leaves(4);
    expect(verifyInclusion(l[0] as Buffer, 4, 4, [], merkleRoot(l))).toBe(false);
    expect(() => inclusionPath(4, l)).toThrow(RangeError);
  });
});

describe("canonical entry encoding", () => {
  it("does not depend on object key order", () => {
    const a = canonicalEntry(entry());
    const b = canonicalEntry({
      archivedAt: "2026-08-27T09:14:00.000Z",
      sizeBytes: 4096,
      sha256: "a".repeat(64),
      tenantId: "22222222-2222-4222-8222-222222222222",
      documentId: "11111111-1111-4111-8111-111111111111",
    });
    expect(a.equals(b)).toBe(true);
  });

  it("is case-insensitive on the digest but nothing else", () => {
    expect(
      canonicalEntry(entry({ sha256: "A".repeat(64) })).equals(canonicalEntry(entry())),
    ).toBe(true);
    expect(
      canonicalEntry(entry({ documentId: "OTHER" })).equals(canonicalEntry(entry())),
    ).toBe(false);
  });

  it("carries a version tag so the encoding can change without silent breakage", () => {
    expect(canonicalEntry(entry()).toString("utf8")).toContain("belegbox.archive.v1");
  });

  it("refuses a field containing the separator", () => {
    expect(() => canonicalEntry(entry({ documentId: "a\u001fb" }))).toThrow(/separator/);
  });

  it("distinguishes entries that differ only in size", () => {
    expect(hex(entryLeafHash(entry({ sizeBytes: 1 })))).not.toBe(
      hex(entryLeafHash(entry({ sizeBytes: 2 }))),
    );
  });
});

describe("sealing a day", () => {
  const day = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      entry({
        documentId: `doc-${String(i).padStart(3, "0")}`,
        sha256: String(i).padStart(64, "0"),
        archivedAt: `2026-08-27T09:${String(i).padStart(2, "0")}:00.000Z`,
      }),
    );

  it("orders entries deterministically regardless of input order", () => {
    const entries = day(5);
    const shuffled = [entries[3], entries[0], entries[4], entries[1], entries[2]] as ArchiveEntry[];
    expect(orderEntries(shuffled).map((e) => e.documentId)).toEqual(
      entries.map((e) => e.documentId),
    );
  });

  it("produces the same root whatever order the rows arrive in", () => {
    const entries = day(7);
    const a = sealDay({ day: "2026-08-27", tenantId: "t", entries, prevRoot: null });
    const b = sealDay({
      day: "2026-08-27",
      tenantId: "t",
      entries: [...entries].reverse(),
      prevRoot: null,
    });
    expect(a.link.merkleRoot).toBe(b.link.merkleRoot);
  });

  // A gap in the chain is indistinguishable from a deletion, which is the
  // exact property GoBD Vollständigkeit asks us to demonstrate.
  it("seals a day with no documents", () => {
    const { link } = sealDay({ day: "2026-08-28", tenantId: "t", entries: [], prevRoot: "ab" });
    expect(link.treeSize).toBe(0);
    expect(link.merkleRoot).toHaveLength(64);
  });

  it("proves and verifies inclusion for every document in a day", () => {
    const entries = day(11);
    const { link } = sealDay({ day: "2026-08-27", tenantId: "t", entries, prevRoot: null });

    for (const e of entries) {
      const proof = proveInclusion(entries, e.documentId, link);
      expect(verifyEntryProof(e, proof), e.documentId).toBe(true);
    }
  });

  // The auditor's check: the proof plus the document, without the archive.
  it("verifies a proof against a reconstructed entry", () => {
    const entries = day(6);
    const { link } = sealDay({ day: "2026-08-27", tenantId: "t", entries, prevRoot: null });
    const proof = proveInclusion(entries, "doc-002", link);

    const independent: ArchiveEntry = {
      documentId: "doc-002",
      tenantId: entries[2]?.tenantId as string,
      sha256: entries[2]?.sha256 as string,
      sizeBytes: entries[2]?.sizeBytes as number,
      archivedAt: entries[2]?.archivedAt as string,
    };
    expect(verifyEntryProof(independent, proof)).toBe(true);
  });

  it("fails verification when the document bytes changed", () => {
    const entries = day(6);
    const { link } = sealDay({ day: "2026-08-27", tenantId: "t", entries, prevRoot: null });
    const proof = proveInclusion(entries, "doc-002", link);

    const altered = { ...(entries[2] as ArchiveEntry), sha256: "f".repeat(64) };
    expect(verifyEntryProof(altered, proof)).toBe(false);
  });

  it("refuses to emit a proof when the sealed root no longer matches", () => {
    const entries = day(4);
    const { link } = sealDay({ day: "2026-08-27", tenantId: "t", entries, prevRoot: null });
    const tampered = [...entries, entry({ documentId: "doc-999" })];
    expect(() => proveInclusion(tampered, "doc-000", link)).toThrow(/integrity/i);
  });

  it("refuses a proof for a document that is not in the day", () => {
    const entries = day(4);
    const { link } = sealDay({ day: "2026-08-27", tenantId: "t", entries, prevRoot: null });
    expect(() => proveInclusion(entries, "doc-nope", link)).toThrow(/not in the entries/);
  });
});

describe("day chain", () => {
  function chain(days: number): ChainLink[] {
    const links: ChainLink[] = [];
    let prevRoot: string | null = null;
    for (let i = 0; i < days; i++) {
      const { link } = sealDay({
        day: `2026-08-${String(i + 1).padStart(2, "0")}`,
        tenantId: "t",
        entries: [entry({ documentId: `d-${i}`, archivedAt: `2026-08-0${1}T00:00:00.000Z` })],
        prevRoot,
        sealedAt: "2026-09-01T00:00:00.000Z",
      });
      links.push(link);
      prevRoot = link.merkleRoot;
    }
    return links;
  }

  it("accepts a well-formed chain", () => {
    expect(verifyChain(chain(5))).toEqual({ valid: true, problems: [] });
  });

  it("accepts a single link with a null previous root", () => {
    expect(verifyChain(chain(1)).valid).toBe(true);
  });

  it("rejects a chain whose first link claims a predecessor", () => {
    const links = chain(3);
    (links[0] as ChainLink).prevRoot = "ff".repeat(32);
    expect(verifyChain(links).problems[0]?.code).toBe("broken_link");
  });

  // Rewriting any past day invalidates that day and every day after it. The
  // archive cannot stop an operator editing a row - it makes the edit visible.
  it("detects a rewritten day", () => {
    const links = chain(6);
    (links[2] as ChainLink).merkleRoot = "de".repeat(32);
    const result = verifyChain(links);
    expect(result.valid).toBe(false);
    expect(result.problems.some((p) => p.code === "broken_link")).toBe(true);
  });

  it("detects a removed day", () => {
    const links = chain(5);
    links.splice(2, 1);
    expect(verifyChain(links).valid).toBe(false);
  });

  it("detects links from another tenant spliced in", () => {
    const links = chain(3);
    (links[1] as ChainLink).tenantId = "other";
    expect(verifyChain(links).problems.some((p) => p.code === "mixed_tenant")).toBe(true);
  });

  it("detects duplicate days", () => {
    const links = chain(3);
    links.push({ ...(links[2] as ChainLink) });
    expect(verifyChain(links).problems.some((p) => p.code === "out_of_order")).toBe(true);
  });

  it("verifies regardless of the order links are handed over in", () => {
    const links = chain(4);
    expect(verifyChain([...links].reverse()).valid).toBe(true);
  });
});

describe("proof serialisation", () => {
  it("survives a JSON round trip", () => {
    const entries = [entry({ documentId: "a" }), entry({ documentId: "b" })];
    const { link } = sealDay({ day: "2026-08-27", tenantId: "t", entries, prevRoot: null });
    const proof = proveInclusion(entries, "a", link);

    const roundTripped = JSON.parse(JSON.stringify(proof)) as typeof proof;
    expect(verifyEntryProof(entries[0] as ArchiveEntry, roundTripped)).toBe(true);
    expect(roundTripped.path.every((p) => unhex(p).length === 32)).toBe(true);
  });
});
