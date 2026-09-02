import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDocument, getTenant, type Finding } from "../../../lib/api";
import { FORMAT_LOCALE, explanationLanguage, type Key, type Translate } from "../../../lib/i18n";
import { resolveUi } from "../../../lib/i18n/server";
import { STATUS_META, VERDICT_META } from "../../../lib/status";
import { Chrome } from "../../nav";
import { PaymentPanel } from "./payment";

export const dynamic = "force-dynamic";

const SEVERITY_CLASS: Record<string, string> = {
  form_error: "bad",
  content_error: "bad",
  warning: "warn",
  info: "",
};

const LAYER_KEY: Record<string, Key> = {
  l1_schema: "doc.layer.l1",
  l2_schematron: "doc.layer.l2",
  l3_domain: "doc.layer.l3",
  l4_tenant: "doc.layer.l4",
};

function FindingCard({
  finding,
  t,
  lang,
}: {
  finding: Finding;
  t: Translate;
  /** The interface language, to notice when the explanation is not in it. */
  lang: string;
}) {
  const explanation = finding.explanation;
  const layer = LAYER_KEY[finding.layer];

  // A finding shows exactly one explanation block, in one language.
  //
  // It used to show several at once, and on a Turkish screen that came out as:
  // the English validator line under "what this means", the same English line
  // again under "in German, to forward to your supplier", a German disclaimer,
  // a Turkish disclaimer, and two more notes. Every branch rendered whenever
  // its field happened to be set, so the fallback - where the renderer echoes
  // the raw message into both languages because there is no template - printed
  // the same untranslated sentence twice and labelled one of them German.
  const explained = explanation && !explanation.fallback ? explanation : null;

  return (
    <div className="sec">
      <p className="lbl">
        {layer ? t(layer) : finding.layer} · {finding.code}
        {finding.btRef ? ` · ${finding.btRef}` : ""}
      </p>

      {/* The raw output, verbatim, next to the explanation and never instead of
          it. Showing what the official tool actually said is the transparency
          the product is arguing for - but it is the tool's wording, usually
          English, and unlabelled it just reads as a screen that forgot which
          language it was in. */}
      <p className="lbl">{t("doc.rawLabel")}</p>
      <pre className="code">{finding.messageRaw}</pre>
      <p className="hint">{t("doc.rawNote")}</p>

      {explained ? (
        <div className="ai" style={{ marginTop: 12 }}>
          <p className="lbl">{t("doc.whatItMeans")}</p>
          {/* Reviewed wording exists in German and Turkish only, so eight of the
              ten interface languages read their explanations in German. The
              account screen says so; saying it again here is the difference
              between a stated limit and a screen that looks broken, because
              this is where the reader actually meets it. */}
          {explained.locale !== lang ? (
            <p className="hint" style={{ marginTop: 0 }}>{t("doc.explanationLanguage")}</p>
          ) : null}
          <p>{explained.observation}</p>
          {explained.legalBasis ? <p className="basis">{explained.legalBasis}</p> : null}
          {explained.nextStep ? <p className="step">{explained.nextStep}</p> : null}

          {/* Only when there is real German text to forward. In the fallback
              case the "German" version is the same raw line as the primary
              one, and offering it as something to send a supplier is a lie. */}
          {explained.locale !== "de" ? (
            <details>
              <summary>{t("doc.germanSummary")}</summary>
              <p>{explained.german.observation}</p>
              <p className="basis">{explained.german.legalBasis}</p>
              <p className="disclaimer">{explained.german.disclaimer}</p>
            </details>
          ) : null}

          {/* Appended by the renderer, not by the template. It cannot be
              switched off, which is the point (StBerG § 2-5). */}
          <p className="disclaimer">{explained.disclaimer}</p>

          {!explained.approved ? <p className="disclaimer">{t("doc.draft")}</p> : null}
        </div>
      ) : (
        /* No explanation to show, and the reason said in the reader's own
           language rather than left blank. Blank is what a Turkish user got
           whenever the legal review had not cleared - a finding with an English
           technical line under it and nothing else. */
        <div className="ai" style={{ marginTop: 12 }}>
          <p className="disclaimer" style={{ borderTop: 0, paddingTop: 0, margin: 0 }}>
            {finding.explanationWithheld ? t("doc.explanationPending") : t("doc.noTemplate")}
          </p>
        </div>
      )}

      {/* The rule's own parameter names, which are identifiers rather than
          words - `line_vat_rate`, `vat_gap`. Printed as a bare table they read
          as more untranslated prose in the middle of the page; behind a labelled
          disclosure they read as what they are, and stay one click away. */}
      {Object.keys(finding.params).length > 0 ? (
        <details style={{ marginTop: 12 }}>
          <summary className="lbl" style={{ cursor: "pointer" }}>
            {t("doc.technicalDetails")}
          </summary>
          <table className="led" style={{ marginTop: 8 }}>
            <tbody>
              {Object.entries(finding.params).map(([key, value]) => (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td>{String(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}

export default async function DocumentDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const tenant = await getTenant();
  if (!tenant) redirect("/login");
  const { t, lang } = await resolveUi();

  const { id } = await params;
  const doc = await getDocument(id);
  if (!doc) notFound();

  const form = VERDICT_META[doc.verdict.form];
  const content = VERDICT_META[doc.verdict.content];
  const status = STATUS_META[doc.status];

  const errors = doc.findings.filter((f) => f.severity.endsWith("_error"));
  const warnings = doc.findings.filter((f) => f.severity === "warning");
  const rest = doc.findings.filter(
    (f) => !f.severity.endsWith("_error") && f.severity !== "warning",
  );

  return (
    <div className="shell">
      <Chrome tenantName={tenant.name} current="inbox" t={t} />

      <Link className="back" href="/inbox">
        ← {t("nav.inbox")}
      </Link>

      <div className="pad" style={{ paddingTop: 0 }}>
        <h2>{t(status.key)}</h2>
        <p className="sub">
          {doc.format ? doc.format.replace(/_/g, " ") : t("doc.unknownFormat")}
          {doc.archivedAt ? ` · ${t("doc.archived")}` : ""}
        </p>
      </div>

      {/* Two independent judgements, side by side. A document can be
          syntactically perfect and materially wrong, and merging these into one
          score would hide exactly the case the product exists for. */}
      <div className="sec">
        <div className="verdicts">
          <div className={`vd ${form.cls}`}>
            <p className="vt">{t("doc.formCheck")}</p>
            <p className="vv">{t(form.key)}</p>
          </div>
          <div className={`vd ${content.cls}`}>
            <p className="vt">{t("doc.contentCheck")}</p>
            <p className="vv">{t(content.key)}</p>
          </div>
        </div>
        {doc.verdict.form === "unknown" ? (
          <p className="note" style={{ marginTop: 10 }}>
            {t("doc.unknownNote")}
          </p>
        ) : null}
      </div>

      <PaymentPanel id={doc.id} t={t} explainLang={explanationLanguage(lang)} />

      {[...errors, ...warnings, ...rest].map((finding) => (
        <FindingCard key={finding.id} finding={finding} t={t} lang={lang} />
      ))}

      {doc.findings.length === 0 ? (
        <div className="sec">
          <p className="note">{t("doc.noFindings")}</p>
        </div>
      ) : null}

      <div className="sec">
        <p className="lbl">{t("doc.evidence")}</p>
        <table className="led">
          <tbody>
            <tr>
              <td>{t("doc.profile")}</td>
              <td>{doc.profileUrn ?? "—"}</td>
            </tr>
            <tr>
              <td>{t("doc.received")}</td>
              <td>{new Date(doc.receivedAt).toLocaleString(FORMAT_LOCALE)}</td>
            </tr>
            {doc.findings[0] ? (
              <>
                <tr>
                  <td>{t("doc.validatorConfig")}</td>
                  <td>{doc.findings[0].versions.validatorConfig}</td>
                </tr>
                <tr>
                  <td>{t("doc.engine")}</td>
                  <td>{doc.findings[0].versions.engine}</td>
                </tr>
              </>
            ) : null}
          </tbody>
        </table>
        <p className="note" style={{ marginTop: 10 }}>
          {t("doc.versionsNote")}
        </p>
      </div>
    </div>
  );
}
