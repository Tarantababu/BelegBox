/**
 * Chart of accounts mapping.
 *
 * PRD § 2.3 names this as one of the three places sector difference actually
 * lives, and like the other two it is data rather than code. The defaults below
 * are the common German charts; a ruleset overrides them per tenant, and a
 * Steuerberater will want to.
 *
 * The mapping deliberately covers only what an incoming invoice needs. Getting
 * this wrong does not corrupt anything - the Steuerberater sees the booking and
 * corrects it - but getting it approximately right is what makes the export
 * worth importing rather than re-keying.
 */

export type ChartOfAccounts = "SKR03" | "SKR04";

export interface AccountMapping {
  chart: ChartOfAccounts;
  /** Where the expense lands, by VAT rate. */
  expenseByRate: Record<string, string>;
  /** Fallback when the rate is not in the table. */
  expenseDefault: string;
  /** The contra account: trade payables. */
  payables: string;
  /** Reverse charge under § 13b UStG books differently. */
  reverseCharge: string;
  /** Intra-community acquisition. */
  intraCommunity: string;
  /** Tax-exempt supplies under § 4 UStG. */
  exempt: string;
}

/**
 * SKR03 groups by process, so incoming goods sit in the 3000s.
 *
 * 3400 is Wareneingang 19 %, 3300 is Wareneingang 7 %, 1600 is
 * Verbindlichkeiten aus Lieferungen und Leistungen.
 */
export const SKR03: AccountMapping = {
  chart: "SKR03",
  expenseByRate: { "19": "3400", "7": "3300", "0": "3200" },
  expenseDefault: "3200",
  payables: "1600",
  reverseCharge: "3120",
  intraCommunity: "3425",
  exempt: "3100",
};

/**
 * SKR04 groups by balance-sheet structure, so the same postings sit in the
 * 5000s. A tenant on SKR04 given SKR03 numbers produces a stapel their
 * Steuerberater has to unpick line by line.
 */
export const SKR04: AccountMapping = {
  chart: "SKR04",
  expenseByRate: { "19": "5400", "7": "5300", "0": "5200" },
  expenseDefault: "5200",
  payables: "3300",
  reverseCharge: "5120",
  intraCommunity: "5425",
  exempt: "5100",
};

export const CHARTS: Record<ChartOfAccounts, AccountMapping> = {
  SKR03,
  SKR04,
};

export interface AccountChoice {
  /** The expense account for the posting. */
  account: string;
  /** The contra account. */
  contraAccount: string;
  /**
   * DATEV Buchungsschlüssel. Left empty when the account itself carries the
   * rate, which is the normal case for an automatic account.
   */
  bookingKey: string;
}

/**
 * Chooses accounts for one document.
 *
 * The VAT category decides first, because a reverse-charge invoice booked as an
 * ordinary expense claims input tax that was never charged - the exact mistake
 * D-002 exists to catch upstream.
 */
export function chooseAccounts(
  mapping: AccountMapping,
  input: { vatCategory?: string | null; vatRate?: number | null },
): AccountChoice {
  const category = (input.vatCategory ?? "S").toUpperCase();

  if (category === "AE") {
    return { account: mapping.reverseCharge, contraAccount: mapping.payables, bookingKey: "94" };
  }
  if (category === "K") {
    return { account: mapping.intraCommunity, contraAccount: mapping.payables, bookingKey: "91" };
  }
  if (category === "E" || category === "G" || category === "Z" || category === "O") {
    return { account: mapping.exempt, contraAccount: mapping.payables, bookingKey: "" };
  }

  const rate = input.vatRate === null || input.vatRate === undefined
    ? undefined
    : String(Math.round(input.vatRate));

  return {
    account: (rate && mapping.expenseByRate[rate]) || mapping.expenseDefault,
    contraAccount: mapping.payables,
    bookingKey: "",
  };
}

export function chartFor(name: string | null | undefined): AccountMapping {
  const key = (name ?? "SKR03").toUpperCase();
  return CHARTS[key as ChartOfAccounts] ?? SKR03;
}
