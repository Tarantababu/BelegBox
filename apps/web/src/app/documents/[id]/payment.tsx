import { getGiroCode } from "../../../lib/api";

const money = (value: number) =>
  `${value.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/**
 * M-04. Payment preparation, and deliberately not payment.
 *
 * PRD § 5.5 and ZAG § 1 Abs. 1 Nr. 7: initiating a payment on someone's behalf
 * needs BaFin authorisation and 50.000 EUR of capital. Belegbox produces a QR
 * code and a file; the user carries them to their own bank. The heading says
 * "vorbereiten", never "bezahlen", and the disclaimer is on the screen rather
 * than in the terms.
 */
export async function PaymentPanel({ id, locale }: { id: string; locale: string }) {
  const giro = await getGiroCode(id);
  if (!giro) return null;

  return (
    <div className="sec">
      <h3>Zahlung vorbereiten</h3>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div
          style={{ width: 168, flex: "none", background: "#fff", padding: 8, borderRadius: 3 }}
          // The QR is generated SVG from our own encoder, not user content.
          dangerouslySetInnerHTML={{ __html: giro.svg }}
        />
        <div style={{ flex: 1, minWidth: 230 }}>
          <p className="lbl">GiroCode — mit der Banking-App scannen</p>
          <table className="led">
            <tbody>
              <tr>
                <td>Empfänger</td>
                <td>{giro.beneficiary}</td>
              </tr>
              <tr>
                <td>IBAN</td>
                <td>{giro.iban.replace(/(.{4})/g, "$1 ").trim()}</td>
              </tr>
              <tr>
                <td>Betrag</td>
                <td>{money(giro.amount)}</td>
              </tr>
              <tr>
                <td>Verwendungszweck</td>
                <td>{giro.reference || "—"}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Shown, not hidden behind a toggle: the point is that the user checks
          the IBAN against the invoice before their bank acts on it. */}
      <p className="lbl" style={{ marginTop: 14 }}>
        Inhalt des Codes (EPC-069-12) — {giro.byteLength} Bytes
      </p>
      <pre className="code">{giro.payload}</pre>

      <p className="note" style={{ marginTop: 12, color: "var(--ink3)" }}>
        {locale === "tr" ? giro.disclaimer.tr : giro.disclaimer.de}
      </p>
    </div>
  );
}
