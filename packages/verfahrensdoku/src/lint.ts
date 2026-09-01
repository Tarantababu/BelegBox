/**
 * Refuses wording that certifies rather than describes.
 *
 * A Verfahrensdokumentation is evidence the business puts in front of a
 * Betriebsprüfer. Whether the described process satisfies the GoBD is a
 * judgement, and it belongs to the business's Steuerberater or
 * Wirtschaftsprüfer - the same line § 2-5 StBerG draw around tax advice, and
 * the same line `@belegbox/explain` polices for findings.
 *
 * The failure mode is specific and expensive. A generated document that says
 * "GoBD-konform" is a claim the auditor will test against the actual process,
 * including the parts that never ran through Belegbox. If it does not hold, the
 * business is worse off than with no document at all: it has now made a written
 * statement that is wrong.
 *
 * So the generator states what the system does - "Objekte werden mit S3 Object
 * Lock im Modus COMPLIANCE geschrieben" - and never what that amounts to.
 * Describing is safe; concluding is not ours.
 *
 * Build-time, not review-time, for the reason the explain lint is: the
 * offending sentences read well and would survive a proofread.
 */

export interface LintRule {
  pattern: RegExp;
  why: string;
}

const RULES: LintRule[] = [
  {
    pattern: /\bgobd[\s-]?(konform|gerecht|sicher)\b/i,
    why: "certifies conformity; describe what the system does and let the Steuerberater judge",
  },
  {
    pattern: /\b(revisions|rechts|prüfungs|audit)sicher\b/i,
    why: "a conclusion about legal standing, not a description of the mechanism",
  },
  {
    pattern: /\berfüllt\s+(alle\s+|sämtliche\s+)?(die\s+)?(gesetzlichen\s+)?anforderungen\b/i,
    why: "asserts the requirements are met, which is the auditor's finding to make",
  },
  {
    pattern: /\b(vom|durch das)\s+finanzamt\s+anerkannt\b/i,
    why: "claims an approval no tax office has given",
  },
  {
    pattern: /\b(zertifiziert|testiert|geprüft\s+und\s+freigegeben)\b/i,
    why: "claims a certification; name the actual audit and its date instead",
  },
  {
    pattern: /\bwir\s+(bestätigen|garantieren|versichern)\b/i,
    why: "gives a warranty the generator is in no position to give",
  },
  {
    pattern: /\b(garantiert|zweifelsfrei|hundertprozentig)\b/i,
    why: "overstates certainty in a document that will be tested against reality",
  },
  {
    pattern: /\bvollständig\s+dokumentiert\b/i,
    why: "claims completeness while the open items are still unanswered",
  },
  {
    pattern: /\b(du|sie)\s+(musst|müssen|solltest|sollten)\b/i,
    why: "instructs the reader personally; state what the statute requires instead",
  },
];

export interface LintFinding {
  where: string;
  text: string;
  why: string;
}

/**
 * Checks one string.
 *
 * Exported so a test can assert the rules bite, and so section authors get the
 * same check the whole document gets.
 */
export function lintText(where: string, text: string): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match) {
      findings.push({ where, text: match[0], why: rule.why });
    }
  }
  return findings;
}

export function lintRuleCount(): number {
  return RULES.length;
}
