import { createHash } from "node:crypto";

/**
 * Merkle tree following RFC 6962 (Certificate Transparency).
 *
 * The prefix bytes are not decoration. Without domain separation a leaf hash
 * and an internal node hash are drawn from the same space, and an attacker can
 * present an internal node as though it were a leaf - the second-preimage
 * attack that made Bitcoin's tree malleable. Leaves are hashed with 0x00,
 * internal nodes with 0x01.
 *
 * RFC 6962 also splits at the largest power of two rather than duplicating the
 * last node to pad to an even count. Duplicating is the other half of that same
 * Bitcoin defect (CVE-2012-2459): two different trees produce one root. Here,
 * one set of leaves has exactly one root.
 */

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

export function sha256(...parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

export function hashLeaf(data: Buffer): Buffer {
  return sha256(LEAF_PREFIX, data);
}

export function hashNode(left: Buffer, right: Buffer): Buffer {
  return sha256(NODE_PREFIX, left, right);
}

/** Largest power of two strictly less than n. Requires n > 1. */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * Merkle Tree Hash over already-hashed leaves.
 *
 * The empty tree hashes to SHA-256 of the empty string, per RFC 6962. A day
 * with no documents still seals, so the chain has no gaps.
 */
export function merkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) return sha256(Buffer.alloc(0));
  if (leaves.length === 1) return leaves[0] as Buffer;

  const k = splitPoint(leaves.length);
  return hashNode(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

/**
 * Inclusion path for the leaf at `index`, ordered leaf-upwards.
 *
 * RFC 6962 PATH(m, D).
 */
export function inclusionPath(index: number, leaves: Buffer[]): Buffer[] {
  if (index < 0 || index >= leaves.length) {
    throw new RangeError(`index ${index} is outside a tree of ${leaves.length} leaves`);
  }
  if (leaves.length === 1) return [];

  const k = splitPoint(leaves.length);
  if (index < k) {
    return [...inclusionPath(index, leaves.slice(0, k)), merkleRoot(leaves.slice(k))];
  }
  return [...inclusionPath(index - k, leaves.slice(k)), merkleRoot(leaves.slice(0, k))];
}

/**
 * Recomputes the root from a leaf and its path.
 *
 * This is the half that matters in an audit: it runs without the archive, from
 * nothing but the document, the proof and the published root. An auditor who
 * does not trust us can still check it.
 */
export function verifyInclusion(
  leafHash: Buffer,
  index: number,
  treeSize: number,
  path: Buffer[],
  root: Buffer,
): boolean {
  if (index < 0 || treeSize <= 0 || index >= treeSize) return false;
  if (treeSize === 1) return path.length === 0 && leafHash.equals(root);

  let fn = index;
  let sn = treeSize - 1;
  let computed = leafHash;

  for (const sibling of path) {
    if (sn === 0) return false;

    if (fn % 2 === 1 || fn === sn) {
      computed = hashNode(sibling, computed);
      while (fn !== 0 && fn % 2 === 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      computed = hashNode(computed, sibling);
    }
    fn >>= 1;
    sn >>= 1;
  }

  return sn === 0 && computed.equals(root);
}

export const hex = (b: Buffer): string => b.toString("hex");
export const unhex = (s: string): Buffer => Buffer.from(s, "hex");
