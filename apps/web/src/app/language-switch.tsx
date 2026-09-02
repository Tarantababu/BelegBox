import { LANGUAGES } from "../lib/i18n";
import { switchLanguageAction } from "./language";

/**
 * Language on the public screens.
 *
 * A plain select and a submit button - no script, because the person this
 * control exists for is the one who cannot read the page it sits on, and a
 * control that only works once JavaScript has loaded is one more thing that can
 * fail them.
 *
 * Every option is written in its own language. "Griechisch" is not findable by
 * someone who reads Greek, which is the entire population this list is for.
 * The label carries both German and English for the same reason: whoever needs
 * it cannot read a label in the language they are trying to leave.
 */
export function LanguageSwitch({ current, next }: { current: string; next: string }) {
  return (
    <form action={switchLanguageAction} className="langswitch">
      <input type="hidden" name="next" value={next} />
      <select name="language" defaultValue={current} aria-label="Sprache · Language">
        {LANGUAGES.map((language) => (
          <option key={language.code} value={language.code}>
            {language.endonym}
          </option>
        ))}
      </select>
      <button className="btn" type="submit" aria-label="Sprache wechseln · Change language">
        ↵
      </button>
    </form>
  );
}
