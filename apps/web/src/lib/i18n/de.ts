/**
 * German, and the source of truth for every other dictionary.
 *
 * `Dict` is derived from this object, so a language file that is missing a key
 * or has invented one fails the typecheck rather than silently rendering the
 * key name to a user.
 *
 * Some words stay German in all ten languages, on purpose:
 *
 *   Verfahrensdokumentation, GoBD, DATEV, EXTF, SKR03/SKR04, Beraternummer,
 *   Mandantennummer, USt-IdNr., XRechnung, ZUGFeRD, Factur-X, KoSIT, GiroCode
 *
 * They are either proper nouns or the literal caption of a field the user has
 * to find in someone else's software. A Polish speaker who has to tell their
 * Steuerberatung which "numer doradcy" they meant has been made worse off. The
 * sentence around the term is translated; the term is not.
 *
 * Placeholders are {name} and are filled by `t`.
 */
export const de = {
  "meta.description": "E-Rechnungen empfangen, prüfen und archivieren",

  "nav.signOut": "Abmelden",
  "nav.inbox": "Eingang",
  "nav.checked": "Geprüft",
  "nav.archive": "Archiv",
  "nav.datev": "DATEV-Export",
  "nav.doku": "Verfahrensdokumentation",
  "nav.account": "Konto",

  "common.search": "Suchen",
  "common.back": "Zurück",
  "common.next": "Weiter",
  "common.copy": "Kopieren",
  "common.copied": "Kopiert",
  "common.unknownSender": "Unbekannter Absender",
  "common.email": "E-Mail-Adresse",
  "common.password": "Passwort",
  "common.currentPassword": "Aktuelles Passwort",
  "common.passwordHint": "Mindestens 12 Zeichen. Länge schützt besser als Sonderzeichen.",
  "common.totpLabel": "Code aus deiner Authenticator-App",
  "common.totpHint": "Sechs Ziffern, wechselt alle 30 Sekunden.",

  "status.clean": "Sauber",
  "status.form_error": "Formfehler",
  "status.content_error": "Sachfehler",
  "status.not_einvoice": "Keine E-Rechnung",
  "status.pending": "In Prüfung",

  "verdict.pass": "Bestanden",
  "verdict.fail": "Fehlerhaft",
  "verdict.n_a": "Nicht anwendbar",
  "verdict.unknown": "Noch offen",

  "login.title": "Anmelden",
  "login.sub": "Zugang zu deinem Rechnungseingang.",
  "login.submit": "Anmelden",
  "login.submitting": "Anmelden …",
  "login.forgot": "Passwort vergessen?",
  "login.noAccount": "Noch kein Konto?",
  "login.startSetup": "Einrichtung starten",
  "login.passwordChanged": "Dein Passwort wurde geändert. Alle anderen Sitzungen sind beendet.",

  "inbox.uploadLabel": "Rechnung hochladen",
  "inbox.uploadSubmit": "Prüfen",
  "inbox.uploadHint":
    "XRechnung (XML) oder ZUGFeRD/Factur-X (PDF). Die Datei wird unverändert archiviert, wie eine per E-Mail eingegangene.",
  "inbox.statTotal": "Belege gesamt",
  "inbox.statAttention": "Zu prüfen",
  "inbox.statNotEinvoice": "Keine E-Rechnung",
  "inbox.searchPlaceholder": "Lieferant oder Rechnungsnummer suchen",
  "inbox.emptyTitle": "Noch nichts angekommen.",
  "inbox.emptyBody":
    "Neue E-Rechnungen landen automatisch hier, sobald ein Lieferant an deine Adresse sendet:",

  "archive.title": "Archiv",
  "archive.sub":
    "Alle Belege, auch die aus früheren Jahren. Namen werden in jeder Schreibweise gefunden — Şahin, Sahin, Getränke, Getraenke.",
  "archive.qLabel": "Lieferant, Rechnungsnummer, USt-IdNr. oder Betrag",
  "archive.qPlaceholder": "z. B. Müller, GM-88213, 428,40",
  "archive.fromLabel": "Rechnungsdatum von",
  "archive.toLabel": "bis",
  "archive.statusLabel": "Status",
  "archive.statusAll": "alle",
  "archive.amountLabel": "Betrag von / bis",
  "archive.unavailable": "Die Suche ist gerade nicht erreichbar.",
  "archive.emptyTerm":
    "Kein Beleg zu „{term}“ im Archiv — auch keiner mit ähnlicher Schreibweise.",
  "archive.emptyPeriod": "Keine Belege in diesem Zeitraum.",
  "archive.similar":
    "Keine genaue Übereinstimmung mit „{term}“. {count} {noun} mit ähnlicher Schreibweise:",
  "archive.forTerm": " zu „{term}“",
  "archive.asAmount": " — als Betrag gelesen: {amount}",
  "archive.docOne": "Beleg",
  "archive.docMany": "Belege",
  "archive.over": "über {n}",

  "doc.unknownFormat": "unbekanntes Format",
  "doc.archived": "archiviert",
  "doc.formCheck": "Formprüfung (KoSIT)",
  "doc.contentCheck": "Inhaltsprüfung (Belegbox)",
  "doc.unknownNote":
    "Die Formprüfung konnte nicht ausgeführt werden — der KoSIT-Validator war nicht erreichbar. Belegbox rät kein Ergebnis; das Urteil bleibt offen, bis die Prüfung durchläuft.",
  "doc.whatItMeans": "Was das bedeutet",
  "doc.germanSummary": "Auf Deutsch — zum Weiterleiten an Lieferant oder Steuerberatung",
  "doc.noTemplate":
    "Für diese Regel gibt es noch keinen geprüften Erklärungstext. Oben steht die Rohausgabe des Validators.",
  "doc.draft": "Entwurfstext — die juristische Prüfung dieser Erklärung steht noch aus.",
  "doc.noFindings": "Keine Beanstandungen.",
  "doc.evidence": "Nachweis",
  "doc.profile": "Profil",
  "doc.received": "Eingegangen",
  "doc.validatorConfig": "Validator-Konfiguration",
  "doc.engine": "Prüf-Engine",
  "doc.versionsNote":
    "Diese Versionen gehören zum Urteil, damit es sich später nachvollziehen lässt.",
  "doc.layer.l1": "L1 · Schema (XSD)",
  "doc.layer.l2": "L2 · Schematron (KoSIT)",
  "doc.layer.l3": "L3 · Fachprüfung (Belegbox)",
  "doc.layer.l4": "L4 · Eigenes Regelwerk",

  "pay.title": "Zahlung vorbereiten",
  "pay.scan": "GiroCode — mit der Banking-App scannen",
  "pay.beneficiary": "Empfänger",
  "pay.iban": "IBAN",
  "pay.amount": "Betrag",
  "pay.reference": "Verwendungszweck",
  "pay.payload": "Inhalt des Codes (EPC-069-12) — {bytes} Bytes",

  "exp.title": "DATEV-Export",
  "exp.sub": "Buchungsstapel im Format EXTF, wie deine Steuerberatung ihn importiert.",
  "exp.from": "Zeitraum von",
  "exp.to": "bis",
  "exp.berater": "Beraternummer",
  "exp.beraterHint":
    "Diese Nummern vergibt deine Steuerberatung. Ohne sie kann DATEV den Stapel nicht zuordnen.",
  "exp.mandant": "Mandantennummer",
  "exp.chart": "Kontenrahmen",
  "exp.chartHint":
    "Der falsche Kontenrahmen erzeugt einen Stapel, den deine Steuerberatung Zeile für Zeile korrigieren muss.",
  "exp.download": "Stapel herunterladen",
  "exp.included":
    "Der Export ist in jedem bezahlten Tarif enthalten. Die Datei ist Windows-1252-kodiert und festgeschrieben, wie GoBD es für Buchungen vorsieht.",
  "exp.belegeTitle": "Belege zum Stapel",
  "exp.belegeSub":
    "Die Originaldateien zum selben Zeitraum, als ZIP — genau die Bytes, die eingegangen sind. Ein Belegverzeichnis liegt bei, mit Prüfsumme und Archivtag zu jedem Beleg.",
  "exp.belegeDownload": "Belege herunterladen",
  "exp.belegeHint":
    "Belege, deren gespeicherte Bytes nicht mehr zu ihrer archivierten Prüfsumme passen, werden nicht beigelegt — sie stehen mit Grund im Belegverzeichnis.",

  "doku.sub":
    "Beschreibt, wie Eingangsrechnungen bei euch ankommen, geprüft und aufbewahrt werden — mit Angabe, woher jede Angabe stammt.",
  "doku.failed": "Die Fassung konnte nicht erzeugt werden ({error}).",
  "doku.created": "Fassung {n} wurde erzeugt und abgelegt.",
  "doku.generateFirst": "Erste Fassung erzeugen",
  "doku.generateNext": "Neue Fassung erzeugen",
  "doku.generateHint":
    "Jede Fassung hält den Stand des Systems zu ihrem Zeitpunkt fest. Frühere Fassungen bleiben erhalten.",
  "doku.openItems":
    "Fassung {n} enthält {count} Punkte, die nur ihr beantworten könnt — andere Eingangswege, Kassenführung, Vertretungsregelung. Belegbox kann sie nicht sehen und trägt sie deshalb nicht ein.",
  "doku.chainBroken": "Die Kette der Fassungen bricht bei Fassung {n}.",
  "doku.none": "Es gibt noch keine Fassung.",
  "doku.colVersion": "Fassung",
  "doku.colDate": "Stand",
  "doku.colOpen": "Offene Punkte",
  "doku.colHash": "Prüfsumme",
  "doku.openNone": "keine",
  "doku.view": "Ansehen",

  "acct.sub": "Sprache, zweiter Faktor und Zugangsschlüssel.",
  "acct.langTitle": "Sprache",
  "acct.langLabel": "Sprache der Oberfläche",
  "acct.langSub":
    "Gilt für dich, nicht für den Betrieb — wer sonst noch in diesem Konto arbeitet, behält seine eigene Einstellung.",
  "acct.langSave": "Sprache speichern",
  "acct.langSaving": "Wird gespeichert…",
  "acct.langSaved": "Sprache gespeichert.",
  "acct.langExplainNote":
    "Die Erklärungen zu den Prüfergebnissen gibt es bisher nur auf Deutsch und Türkisch. Sie sind juristisch geprüfter Text und werden nicht maschinell übersetzt — in jeder anderen Sprache erscheinen sie auf Deutsch.",
  "acct.langExplainOk":
    "Die Erklärungen zu den Prüfergebnissen gibt es in dieser Sprache.",
  "acct.keysTitle": "API-Schlüssel",
  "acct.keysSub":
    "Für eigene Anbindungen — ein Kassensystem, das Rechnungen übergibt. Ein Schlüssel authentifiziert den Mandanten, nicht eine Person: er kann keinen zweiten Faktor ändern und keine weiteren Schlüssel anlegen.",
  "acct.keysNone": "Es gibt noch keine Schlüssel.",
  "acct.colName": "Name",
  "acct.colEnv": "Umgebung",
  "acct.colPrefix": "Kennung",
  "acct.colLastUsed": "Zuletzt benutzt",
  "acct.revoke": "Sperren",
  "acct.revoked": "gesperrt {date}",
  "acct.ownerOnly": "API-Schlüssel verwaltet der Inhaber des Kontos.",
  "acct.newKeyTitle": "Neuen Schlüssel anlegen",
  "acct.keyNameHint": "Wofür der Schlüssel benutzt wird — sichtbar in der Liste.",
  "acct.keyNamePlaceholder": "z. B. Kassensystem",
  "acct.createKey": "Schlüssel anlegen",
  "acct.creatingKey": "Wird angelegt…",
  "acct.keyShown": "Schlüssel „{name}“",
  "acct.keyOnce":
    "Dieser Schlüssel wird nur jetzt angezeigt. Gespeichert ist nur seine Prüfsumme — es gibt keinen Weg, ihn später noch einmal zu sehen. Geht er verloren, wird er ersetzt, nicht wiederhergestellt.",

  "mfa.title": "Zwei-Faktor-Anmeldung",
  "mfa.codesLeft": "{n} Wiederherstellungscodes sind noch nicht verbraucht.",
  "mfa.codesNone":
    "Es sind keine Wiederherstellungscodes hinterlegt. Beim Neueinrichten werden zehn erzeugt.",
  "mfa.passwordHint":
    "Wird erneut abgefragt, weil hier die Anmeldedaten selbst geändert werden. Eine übernommene Sitzung allein soll dafür nicht reichen.",
  "mfa.begin": "Neu einrichten",
  "mfa.beginning": "Wird vorbereitet…",
  "mfa.scanTitle": "Neuen Code scannen",
  "mfa.scanNote":
    "In der Authenticator-App hinzufügen, dann den angezeigten Code eingeben. Der bisherige zweite Faktor gilt so lange weiter, bis der neue bestätigt ist.",
  "mfa.orLink": "Oder diesen Link in der App öffnen:",
  "mfa.codeLabel": "Code aus der App",
  "mfa.confirm": "Bestätigen",
  "mfa.confirming": "Wird geprüft…",
  "mfa.recoveryTitle": "Wiederherstellungscodes",
  "mfa.recoveryNote":
    "Jeder Code funktioniert einmal, anstelle des Codes aus der App. Sie werden nur jetzt angezeigt — bitte ausdrucken oder in den Passwortmanager legen. Alle anderen Sitzungen wurden beendet.",

  "setup.title": "Einrichtung",
  "setup.sub": "Drei Angaben, keine Kreditkarte. Am Ende steht deine Adresse für E-Rechnungen.",
  "setup.warn":
    "Seit dem 1. Januar 2025 dürfen Lieferanten E-Rechnungen senden, ohne vorher zu fragen. Die Pflicht, sie zu empfangen und lesbar zu archivieren, gilt damit schon heute — unabhängig davon, ab wann du selbst E-Rechnungen ausstellen musst.",
  "setup.name": "Firmenname",
  "setup.nameHint": "Rechtsform und Umlaute werden für die Adresse automatisch aufgelöst.",
  "setup.taxId": "USt-IdNr. oder Steuernummer",
  "setup.industry": "Branche",
  "setup.industryHint":
    "Wählt das Regelwerk, nach dem eingehende Rechnungen inhaltlich geprüft werden.",
  "setup.chooseSector": "Bitte wählen",
  "setup.sector.gastro": "Gastronomie",
  "setup.sector.handwerk": "Handwerk und Bau",
  "setup.sector.logistik": "Logistik und Transport",
  "setup.sector.handel": "Handel",
  "setup.sector.frei": "Freiberuflich und Agentur",
  "setup.language": "Sprache",
  "setup.submit": "Einrichten",
  "setup.submitting": "Wird eingerichtet …",

  "done.title": "Fast fertig.",
  "done.sub": "Ein Schritt fehlt noch: die Zwei-Faktor-Anmeldung für dein Konto.",
  "done.warn":
    "Dieser Schlüssel wird nur jetzt angezeigt. Trage ihn in deine Authenticator-App ein, bevor du weitergehst — ohne ihn kommst du nicht in dein Konto.",
  "done.secretLabel": "Schlüssel für die Authenticator-App",
  "done.secretNote":
    "Apps wie Aegis, 1Password oder Google Authenticator nehmen diesen Schlüssel direkt entgegen. Beim ersten Anmelden fragen wir nach dem sechsstelligen Code daraus.",
  "done.addressLabel": "Rechnungsadresse",
  "done.addressNote":
    "Die zufällige Endung gehört dazu. Sie sorgt dafür, dass niemand die Adresse aus deinem Firmennamen erraten und dir eine gefälschte Rechnung zustellen kann.",
  "done.noticeLabel": "Text für deine Lieferanten — auf Deutsch, weil er an sie geht",
  "done.signIn": "Jetzt anmelden",

  "reset.title": "Passwort zurücksetzen",
  "reset.sub": "Wir schicken dir einen Link, mit dem du ein neues setzen kannst.",
  "reset.backToLogin": "Zurück zur Anmeldung",
  "reset.request": "Link anfordern",
  "reset.requesting": "Wird gesendet …",
  "reset.sent":
    "Wenn es zu dieser Adresse ein Konto gibt, ist eine E-Mail unterwegs. Der Link gilt eine Stunde und funktioniert nur einmal.",
  "reset.devLink": "Entwicklungsmodus — der Link wird sonst per E-Mail zugestellt",
  "reset.newTitle": "Neues Passwort",
  "reset.newSub":
    "Danach wirst du auf allen Geräten abgemeldet — auch dort, wo du es vielleicht nicht selbst warst.",
  "reset.newPassword": "Neues Passwort",
  "reset.repeat": "Noch einmal",
  "reset.save": "Passwort setzen",
  "reset.saving": "Wird gespeichert …",

  // Messages a server action produces. They come from our own code, not from
  // the API - the API answers in machine-readable codes precisely so the words
  // a user reads are chosen here, in their language, rather than in whatever
  // language the backend happens to log in.
  "err.needPassword": "Bitte das aktuelle Passwort eingeben.",
  "err.needCode": "Bitte den Code aus der App eingeben.",
  "err.needName": "Bitte einen Namen vergeben.",
  "err.mfa.invalid_code": "Der Code stimmt nicht. Er wechselt alle 30 Sekunden.",
  "err.mfa.expired": "Die Einrichtung ist abgelaufen. Bitte noch einmal beginnen.",
  "err.mfa.no_pending_secret": "Es läuft gerade keine Einrichtung. Bitte noch einmal beginnen.",
  "err.language": "Diese Sprache konnte nicht gespeichert werden.",
  "err.credentials": "E-Mail-Adresse oder Passwort stimmt nicht.",
  "err.needEmailPassword": "Bitte E-Mail-Adresse und Passwort eingeben.",
  "err.emailInvalid": "Bitte eine gültige E-Mail-Adresse eingeben.",
  "err.needCompanyName": "Bitte den Firmennamen eingeben.",
  "err.passwordTooShort": "Das Passwort braucht mindestens 12 Zeichen. Länge zählt mehr als Sonderzeichen.",
  "err.passwordMismatch": "Die beiden Passwörter stimmen nicht überein.",
  "err.mfa_enrollment_required": "Für dieses Konto ist eine Zwei-Faktor-Anmeldung erforderlich, sie ist aber nicht fertig eingerichtet. Bitte wende dich an den Inhaber des Kontos.",
  "err.reset.linkSpent": "Dieser Link ist abgelaufen oder wurde schon benutzt. Fordere einen neuen an.",
  "err.reset.failed": "Das hat gerade nicht geklappt. Bitte versuch es noch einmal.",
  "err.upload.noFile": "Bitte eine Datei auswählen.",
  "err.upload.empty": "Die Datei ist leer.",
  "err.upload.failed": "Der Upload hat nicht geklappt.",
  "err.periodRequired": "Bitte einen Zeitraum angeben.",
  "err.datevRequired": "Zeitraum, Beraternummer und Mandantennummer sind erforderlich.",
  "err.doku.badVersion": "Ungültige Fassung.",
  "err.doku.notFound": "Diese Fassung gibt es nicht.",
  "doc.rawLabel": "Wortlaut der Prüfung",
  "doc.rawNote": "Die Prüfwerkzeuge formulieren selbst — der offizielle KoSIT-Validator meist auf Englisch. Dieser Text wird unverändert wiedergegeben und nicht übersetzt, damit er zu dem passt, was der Lieferant bei sich sieht.",
  "doc.explanationPending": "Die Erklärung zu dieser Regel ist geschrieben, aber juristisch noch nicht freigegeben, und wird deshalb nicht angezeigt.",
  "doc.technicalDetails": "Technische Angaben aus der Prüfung",
  "doc.explanationLanguage": "Diese Erklärung ist auf Deutsch.",
} as const;

export type Key = keyof typeof de;
export type Dict = Record<Key, string>;
