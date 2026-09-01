import { isValidBic, isValidIban, normalizeIban } from "./iban.js";

/**
 * SEPA credit transfer initiation, ISO 20022 pain.001.
 *
 * Two versions are emitted. The PRD names `pain.001.001.09`, which is the
 * current SEPA scheme version - and many German online-banking portals still
 * accept only `.03`. Producing a file the user's bank rejects is not a smaller
 * failure than producing none, so the format is theirs to choose.
 *
 * What this is not, and must not become: a payment initiation service. Under
 * ZAG § 1 Abs. 1 Nr. 7 that needs BaFin authorisation and 50.000 EUR of
 * capital. Belegbox writes a file. The user uploads it to their own bank, and
 * the money never touches anything here.
 */

export type PainVersion = "pain.001.001.03" | "pain.001.001.09";

export interface SepaDebtor {
  name: string;
  iban: string;
  bic?: string | undefined;
}

export interface SepaCreditTransfer {
  /** Shown on the statement. Usually the invoice number. */
  endToEndId: string;
  creditorName: string;
  creditorIban: string;
  creditorBic?: string | undefined;
  amount: number;
  remittance: string;
}

export interface SepaFileInput {
  debtor: SepaDebtor;
  transfers: SepaCreditTransfer[];
  /** Defaults to today. Banks reject a date in the past. */
  requestedExecutionDate?: string;
  messageId?: string;
  createdAt?: Date;
  version?: PainVersion;
}

export class SepaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SepaError";
  }
}

/**
 * XML escaping.
 *
 * Creditor names come from invoices that arrive by email, so this is the
 * boundary between an attacker-supplied string and a file the user's bank
 * parses. Apostrophes and quotes are escaped too: the file is read by many
 * different parsers and only some of them are forgiving.
 */
function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * SEPA restricts names and remittance to a Latin subset, and banks silently
 * mangle or reject what falls outside it. Umlauts expand the German way rather
 * than being dropped, so "Müller" stays readable as "Mueller".
 */
function sepaText(value: string, max: number): string {
  return value
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function money(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  if (!Number.isFinite(rounded) || rounded <= 0) {
    throw new SepaError("Every transfer needs a positive amount.");
  }
  return rounded.toFixed(2);
}

function today(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Builds the file.
 *
 * The control sum is computed from the transfers rather than taken on trust:
 * a mismatch between `CtrlSum` and the sum of the instructions is one of the
 * few errors a bank rejects the whole batch for.
 */
export function buildSepaFile(input: SepaFileInput): string {
  const version = input.version ?? "pain.001.001.03";
  const createdAt = input.createdAt ?? new Date();
  const executionDate = input.requestedExecutionDate ?? today(createdAt);

  if (input.transfers.length === 0) {
    throw new SepaError("A payment file needs at least one transfer.");
  }

  const debtorIban = normalizeIban(input.debtor.iban);
  if (!isValidIban(debtorIban)) {
    throw new SepaError(`Debtor IBAN "${input.debtor.iban}" is not valid.`);
  }
  if (input.debtor.bic && !isValidBic(input.debtor.bic)) {
    throw new SepaError(`Debtor BIC "${input.debtor.bic}" is not valid.`);
  }

  const transfers = input.transfers.map((transfer, index) => {
    const iban = normalizeIban(transfer.creditorIban);
    if (!isValidIban(iban)) {
      throw new SepaError(
        `Transfer ${index + 1}: creditor IBAN "${transfer.creditorIban}" is not valid.`,
      );
    }
    if (transfer.creditorBic && !isValidBic(transfer.creditorBic)) {
      throw new SepaError(`Transfer ${index + 1}: creditor BIC is not valid.`);
    }
    return { ...transfer, creditorIban: iban, formattedAmount: money(transfer.amount) };
  });

  const controlSum = transfers
    .reduce((sum, t) => sum + Math.round(Number(t.formattedAmount) * 100), 0) / 100;

  const messageId = sepaText(input.messageId ?? `BB-${createdAt.getTime()}`, 35);
  const isV9 = version === "pain.001.001.09";

  // pain.001.001.09 wraps the execution date and renames the BIC element.
  const executionElement = isV9
    ? `        <ReqdExctnDt><Dt>${executionDate}</Dt></ReqdExctnDt>`
    : `        <ReqdExctnDt>${executionDate}</ReqdExctnDt>`;
  const bicTag = isV9 ? "BICFI" : "BIC";

  const agent = (bic: string | undefined, indent: string, tag: "DbtrAgt" | "CdtrAgt"): string =>
    bic
      ? `${indent}<${tag}><FinInstnId><${bicTag}>${xml(bic.toUpperCase())}</${bicTag}></FinInstnId></${tag}>`
      : // NOTPROVIDED is the SEPA convention for "derive it from the IBAN",
        // which every bank in the scheme can do.
        `${indent}<${tag}><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></${tag}>`;

  const body = transfers
    .map(
      (t, index) => `        <CdtTrfTxInf>
          <PmtId><EndToEndId>${xml(sepaText(t.endToEndId || `NOTPROVIDED-${index + 1}`, 35))}</EndToEndId></PmtId>
          <Amt><InstdAmt Ccy="EUR">${t.formattedAmount}</InstdAmt></Amt>
${agent(t.creditorBic, "          ", "CdtrAgt")}
          <Cdtr><Nm>${xml(sepaText(t.creditorName, 70))}</Nm></Cdtr>
          <CdtrAcct><Id><IBAN>${t.creditorIban}</IBAN></Id></CdtrAcct>
          <RmtInf><Ustrd>${xml(sepaText(t.remittance, 140))}</Ustrd></RmtInf>
        </CdtTrfTxInf>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:${version}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${xml(messageId)}</MsgId>
      <CreDtTm>${createdAt.toISOString().replace(/\.\d{3}Z$/, "Z")}</CreDtTm>
      <NbOfTxs>${transfers.length}</NbOfTxs>
      <CtrlSum>${controlSum.toFixed(2)}</CtrlSum>
      <InitgPty><Nm>${xml(sepaText(input.debtor.name, 70))}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${xml(messageId)}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <BtchBookg>false</BtchBookg>
      <NbOfTxs>${transfers.length}</NbOfTxs>
      <CtrlSum>${controlSum.toFixed(2)}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>
${executionElement}
      <Dbtr><Nm>${xml(sepaText(input.debtor.name, 70))}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>${debtorIban}</IBAN></Id></DbtrAcct>
${agent(input.debtor.bic, "      ", "DbtrAgt")}
      <ChrgBr>SLEV</ChrgBr>
${body}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
}

/** A filename that says what it is and when, for a browser download. */
export function sepaFilename(version: PainVersion, at = new Date()): string {
  return `belegbox-sepa-${version.replace(/\./g, "")}-${today(at)}.xml`;
}
