/**
 * Windows-1252 encoding.
 *
 * DATEV's EXTF format is specified as ANSI, and an import of UTF-8 bytes turns
 * every umlaut into mojibake in the client's books - "Getränke Müller" becomes
 * "GetrÃ¤nke MÃ¼ller" in a ledger that is kept for ten years.
 *
 * Hand-rolled rather than pulled in: Windows-1252 is Latin-1 plus one block of
 * twenty-seven characters, and the mapping is fixed for all time.
 */

/** The 0x80-0x9F block, where Windows-1252 differs from Latin-1. */
const HIGH_BLOCK: Record<string, number> = {
  "€": 0x80, // €
  "‚": 0x82,
  "ƒ": 0x83,
  "„": 0x84, // „
  "…": 0x85, // …
  "†": 0x86,
  "‡": 0x87,
  "ˆ": 0x88,
  "‰": 0x89,
  "Š": 0x8a,
  "‹": 0x8b,
  "Œ": 0x8c,
  "Ž": 0x8e,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93, // “
  "”": 0x94, // ”
  "•": 0x95,
  "–": 0x96, // –
  "—": 0x97, // —
  "˜": 0x98,
  "™": 0x99,
  "š": 0x9a,
  "›": 0x9b,
  "œ": 0x9c,
  "ž": 0x9e,
  "Ÿ": 0x9f,
};

/**
 * Characters with no Windows-1252 representation become this.
 *
 * A question mark rather than being dropped: a bookkeeper seeing "Öztürk?" can
 * tell something was lost, where "Öztürk" silently shortened cannot be
 * distinguished from the supplier's actual name.
 */
const REPLACEMENT = 0x3f;

export function encodeCp1252(text: string): Buffer {
  const bytes: number[] = [];

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;

    if (code <= 0x7f || (code >= 0xa0 && code <= 0xff)) {
      bytes.push(code);
      continue;
    }
    const mapped = HIGH_BLOCK[char];
    if (mapped !== undefined) {
      bytes.push(mapped);
      continue;
    }
    // Turkish ı, ş, ğ and Polish ł have no Windows-1252 code point, and German
    // bookkeeping deals in supplier names that contain them.
    const folded = fold(char);
    if (folded) {
      for (const f of folded) bytes.push(f.charCodeAt(0));
      continue;
    }
    bytes.push(REPLACEMENT);
  }

  return Buffer.from(bytes);
}

/** Transliterations for characters Windows-1252 cannot hold. */
const FOLD: Record<string, string> = {
  ı: "i", İ: "I", ş: "s", Ş: "S", ğ: "g", Ğ: "G",
  ł: "l", Ł: "L", đ: "d", Đ: "D",
  ă: "a", Ă: "A", ș: "s", Ș: "S", ț: "t", Ț: "T",
  ő: "o", Ő: "O", ű: "u", Ű: "U",
};

function fold(char: string): string | undefined {
  if (FOLD[char]) return FOLD[char];
  // A composed character whose base letter survives, e.g. ǎ -> a.
  const decomposed = char.normalize("NFD").replace(/\p{M}+/gu, "");
  if (decomposed && decomposed !== char && /^[\x20-\x7e]+$/.test(decomposed)) {
    return decomposed;
  }
  return undefined;
}

export function canEncodeCp1252(text: string): boolean {
  return [...text].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x7f || (code >= 0xa0 && code <= 0xff) || char in HIGH_BLOCK;
  });
}
