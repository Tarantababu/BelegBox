import { randomBytes } from "node:crypto";

/**
 * Applied before NFD, because these do not decompose into a base letter plus a
 * mark.
 *
 * The umlauts are a judgement call: NFD would fold Döner to "doner", but German
 * convention expands to "doener", and these are German mail addresses that
 * suppliers will read aloud over the phone. The Turkish dotless i and the
 * Polish crossed l are here because NFD cannot reach them at all.
 */
const TRANSLITERATE: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  Ä: "ae",
  Ö: "oe",
  Ü: "ue",
  ı: "i",
  İ: "i",
  ł: "l",
  Ł: "l",
  ß: "ss",
  ø: "o",
  Ø: "o",
  đ: "d",
  Đ: "d",
  æ: "ae",
  Æ: "ae",
  œ: "oe",
  Œ: "oe",
};

/**
 * German legal forms, longest first so "GmbH & Co. KG" is not eaten as "KG".
 * These carry no identity and would make every inbox address longer for nothing.
 */
const LEGAL_FORMS = [
  "gmbh & co. kg",
  "gmbh & co kg",
  "ug haftungsbeschraenkt",
  "haftungsbeschraenkt",
  "gmbh",
  "mbh",
  "ohg",
  "gbr",
  "kgaa",
  "e.k.",
  "e.kfm.",
  "e.v.",
  "ug",
  "ag",
  "kg",
  "se",
];

/** ASCII-folds a company name into a mail-safe slug. */
export function slugify(companyName: string): string {
  let s = companyName.toLowerCase();

  for (const [from, to] of Object.entries(TRANSLITERATE)) {
    s = s.split(from).join(to);
    s = s.split(from.toLowerCase()).join(to);
  }

  // NFD then drop combining marks: ş -> s, ă -> a, ș -> s, ç -> c.
  s = s.normalize("NFD").replace(/\p{M}+/gu, "");

  // Brackets become separators so "UG (haftungsbeschränkt)" is reachable as
  // two ordinary words by the list below.
  s = s.replace(/[()\[\]]/g, " ");

  for (const form of LEGAL_FORMS) {
    s = s.replace(new RegExp(`(^|[\\s,.-])${escapeRegex(form)}(?=$|[\\s,.])`, "g"), " ");
  }

  s = s
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

  return s || "inbox";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface InboxAddress {
  slug: string;
  /** Unguessable suffix. Without it the address is derivable from a company name. */
  suffix: string;
  localPart: string;
  address: string;
}

/**
 * Builds a tenant inbox address.
 *
 * The random suffix is not decoration. PRD § 10.3 requires the address to be
 * unguessable: anyone who learns it can inject a document that looks like a
 * supplier invoice, and `sahin-doener@belegbox.de` is guessable from the shop
 * sign. Four bytes of entropy is what stands between a company name and an
 * injection point.
 */
export function generateInboxAddress(
  companyName: string,
  domain = "belegbox.de",
  suffix = randomBytes(4).toString("hex"),
): InboxAddress {
  const slug = slugify(companyName);
  const localPart = `${slug}-${suffix}`;
  return { slug, suffix, localPart, address: `${localPart}@${domain}` };
}

export interface ParsedInbox {
  slug: string;
  suffix: string;
  localPart: string;
  domain: string;
}

/**
 * Parses an envelope recipient back into slug and suffix.
 *
 * Returns null for anything that does not carry a suffix - an unroutable
 * message must not fall back to a slug-only match, or the entropy above buys
 * nothing.
 */
export function parseInboxAddress(address: string): ParsedInbox | null {
  const at = address.lastIndexOf("@");
  if (at <= 0) return null;

  let localPart = address.slice(0, at).toLowerCase().trim();
  const domain = address.slice(at + 1).toLowerCase().trim();
  if (!domain) return null;

  // Tolerate plus-addressing: the provider may hand back inbound+<local>@domain.
  const plus = localPart.indexOf("+");
  if (plus >= 0) localPart = localPart.slice(plus + 1);

  const m = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-([0-9a-f]{8})$/.exec(localPart);
  if (!m) return null;

  const [, slug, suffix] = m;
  if (!slug || !suffix) return null;
  return { slug, suffix, localPart, domain };
}
