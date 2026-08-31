import type { Locale } from "./types.js";

/**
 * Refuses wording that crosses from describing into advising.
 *
 * § 2-5 StBerG reserve tax advice in Germany to Steuerberater, and § 160
 * attaches a penalty. A sentence like "the correct rate is 19 %" or "this comes
 * back on you in an audit" assesses *this user's* tax position, which is the
 * side of the line we do not cross. Saying "§ 12 Abs. 2 Nr. 15 UStG puts
 * beverages at 19 %" is a statement about the statute, and is fine.
 *
 * The v2 prototype's explanations failed exactly here, which is why this exists
 * as a build-time check rather than a review convention: the offending strings
 * were fluent, plausible and shipped.
 *
 * Second person is the tell. German "muss" in "Die Rechnung muss die Angabe
 * enthalten" states the law; "Du musst" instructs the reader. Turkish
 * "zorundadır" states it; "zorundasın" instructs. The patterns target the
 * personal forms and leave the impersonal ones alone.
 */

export interface LintRule {
  pattern: RegExp;
  why: string;
}

const GERMAN: LintRule[] = [
  {
    pattern: /\b(du|sie)\s+(musst|müssen|solltest|sollten|darfst|dürfen)\b/i,
    why: "instructs the reader personally; state what the statute requires instead",
  },
  {
    pattern: /\b(richtig|korrekt)\s+(wäre|ist es|gewesen)\b/i,
    why: "declares the correct treatment for this case; cite the general rule instead",
  },
  {
    pattern: /\bin\s+(deinem|ihrem)\s+fall\b/i,
    why: "assesses the reader's individual situation, which is reserved advice",
  },
  {
    pattern: /\bwir\s+(empfehlen|raten)\b/i,
    why: "gives a recommendation; describe the finding and let the Steuerberater advise",
  },
  {
    pattern: /\b(du|sie)\s+(hast|haben)\s+.{0,30}\b(falsch|fehlerhaft)\b/i,
    why: "tells the reader they did something wrong; describe what the document says",
  },
  {
    pattern: /\b(fällt|fallen)\s+.{0,20}\bauf\s+(dich|sie)\s+zurück\b/i,
    why: "predicts a consequence for the reader personally",
  },
  {
    pattern: /\bvorsteuerabzug\b.{0,40}\b(verlierst|verlieren|wird\s+dir)\b/i,
    why: "predicts the reader's input-tax outcome, which is an individual assessment",
  },
];

const TURKISH: LintRule[] = [
  {
    pattern: /\b\w*(malısın|melisin|zorundasın|zorundasınız)\b/i,
    why: "instructs the reader personally; state what the statute requires instead",
  },
  {
    pattern: /\bdoğrusu\b/i,
    why: "declares the correct treatment for this case; cite the general rule instead",
  },
  {
    pattern: /\byapman\s+gereken\b/i,
    why: "tells the reader what to do, which is reserved advice",
  },
  {
    pattern: /\bsenin\s+durumunda\b|\bsizin\s+durumunuzda\b/i,
    why: "assesses the reader's individual situation",
  },
  {
    pattern: /\b(tavsiye|öneri)\s+(ederiz|ediyoruz)\b/i,
    why: "gives a recommendation; describe the finding instead",
  },
  {
    pattern: /\bsana\s+geri\s+döner\b|\bsize\s+geri\s+döner\b/i,
    why: "predicts a consequence for the reader personally",
  },
  {
    pattern: /\byanlış\s+(yapmışsın|yaptın|yapmışsınız)\b/i,
    why: "tells the reader they did something wrong",
  },
];

const SHARED: LintRule[] = [
  {
    pattern: /<[a-z/!]/i,
    why: "contains markup; templates are plain text and the caller escapes",
  },
];

const RULES: Record<Locale, LintRule[]> = {
  de: [...GERMAN, ...SHARED],
  tr: [...TURKISH, ...SHARED],
};

export interface LintProblem {
  locale: Locale;
  field: string;
  matched: string;
  why: string;
}

export function lintText(text: string, locale: Locale, field: string): LintProblem[] {
  const problems: LintProblem[] = [];
  for (const rule of RULES[locale]) {
    const hit = rule.pattern.exec(text);
    if (hit) {
      problems.push({ locale, field, matched: hit[0], why: rule.why });
    }
  }
  return problems;
}

export function describeProblems(problems: LintProblem[]): string {
  return problems
    .map((p) => `[${p.locale}.${p.field}] "${p.matched}" - ${p.why}`)
    .join("; ");
}
