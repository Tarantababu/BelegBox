import type { Dict } from "./de";

/**
 * Arabic. The only right-to-left language in the list - the layout sets
 * dir="rtl" from the registry rather than from a check scattered through the
 * components.
 *
 * The German terms of art stay in Latin script (DATEV, GoBD, XRechnung,
 * Beraternummer, USt-IdNr., Verfahrensdokumentation). The bidi algorithm
 * renders them left to right inside the sentence, which is exactly right: they
 * are what the user has to type into somebody else's software.
 */
export const ar: Dict = {
  "meta.description": "استلام الفواتير الإلكترونية وفحصها وأرشفتها",

  "nav.signOut": "تسجيل الخروج",
  "nav.inbox": "الوارد",
  "nav.checked": "المفحوصة",
  "nav.archive": "الأرشيف",
  "nav.datev": "تصدير DATEV",
  "nav.doku": "Verfahrensdokumentation",
  "nav.account": "الحساب",

  "common.search": "بحث",
  "common.back": "رجوع",
  "common.next": "التالي",
  "common.copy": "نسخ",
  "common.copied": "تم النسخ",
  "common.unknownSender": "مرسل غير معروف",
  "common.email": "البريد الإلكتروني",
  "common.password": "كلمة المرور",
  "common.currentPassword": "كلمة المرور الحالية",
  "common.passwordHint": "١٢ حرفًا على الأقل. الطول يحمي أكثر من الرموز الخاصة.",
  "common.totpLabel": "الرمز من تطبيق المصادقة",
  "common.totpHint": "ستة أرقام، تتغير كل ٣٠ ثانية.",

  "status.clean": "سليمة",
  "status.form_error": "خطأ في الشكل",
  "status.content_error": "خطأ في المضمون",
  "status.not_einvoice": "ليست فاتورة إلكترونية",
  "status.pending": "قيد الفحص",

  "verdict.pass": "اجتازت",
  "verdict.fail": "بها خطأ",
  "verdict.n_a": "لا ينطبق",
  "verdict.unknown": "ما زال مفتوحًا",

  "login.title": "تسجيل الدخول",
  "login.sub": "الدخول إلى وارد فواتيرك.",
  "login.submit": "تسجيل الدخول",
  "login.submitting": "جارٍ الدخول …",
  "login.forgot": "نسيت كلمة المرور؟",
  "login.noAccount": "ليس لديك حساب بعد؟",
  "login.startSetup": "ابدأ الإعداد",
  "login.passwordChanged": "تم تغيير كلمة المرور. أُنهيت جميع الجلسات الأخرى.",

  "inbox.uploadLabel": "رفع فاتورة",
  "inbox.uploadSubmit": "افحص",
  "inbox.uploadHint":
    "XRechnung (XML) أو ZUGFeRD/Factur-X (PDF). يُؤرشَف الملف كما هو دون تغيير، تمامًا كفاتورة وصلت بالبريد الإلكتروني.",
  "inbox.statTotal": "إجمالي المستندات",
  "inbox.statAttention": "تحتاج مراجعة",
  "inbox.statNotEinvoice": "ليست فاتورة إلكترونية",
  "inbox.searchPlaceholder": "ابحث باسم المورّد أو رقم الفاتورة",
  "inbox.emptyTitle": "لم يصل شيء بعد.",
  "inbox.emptyBody":
    "تصل الفواتير الإلكترونية الجديدة إلى هنا تلقائيًا بمجرد أن يرسلها مورّد إلى عنوانك:",

  "archive.title": "الأرشيف",
  "archive.sub":
    "كل المستندات، بما فيها سنوات سابقة. تُوجد الأسماء بأي طريقة كُتبت بها — Şahin وSahin وGetränke وGetraenke.",
  "archive.qLabel": "المورّد أو رقم الفاتورة أو USt-IdNr. أو المبلغ",
  "archive.qPlaceholder": "مثلاً Müller، GM-88213، 428,40",
  "archive.fromLabel": "تاريخ الفاتورة من",
  "archive.toLabel": "إلى",
  "archive.statusLabel": "الحالة",
  "archive.statusAll": "الكل",
  "archive.amountLabel": "المبلغ من / إلى",
  "archive.unavailable": "البحث غير متاح حاليًا.",
  "archive.emptyTerm":
    "لا يوجد مستند لـ «{term}» في الأرشيف — ولا حتى بكتابة مشابهة.",
  "archive.emptyPeriod": "لا توجد مستندات في هذه الفترة.",
  "archive.similar":
    "لا تطابق تامًا لـ «{term}». {count} {noun} بكتابة مشابهة:",
  "archive.forTerm": " لـ «{term}»",
  "archive.asAmount": " — قُرئ كمبلغ: {amount}",
  "archive.docOne": "مستند",
  "archive.docMany": "مستندات",
  "archive.over": "أكثر من {n}",

  "doc.unknownFormat": "صيغة غير معروفة",
  "doc.archived": "مؤرشفة",
  "doc.formCheck": "فحص الشكل (KoSIT)",
  "doc.contentCheck": "فحص المضمون (Belegbox)",
  "doc.unknownNote":
    "تعذّر تنفيذ فحص الشكل — لم يكن مدقّق KoSIT متاحًا. لا يخمّن Belegbox نتيجة؛ يبقى الحكم مفتوحًا حتى يتم الفحص.",
  "doc.whatItMeans": "ما معنى ذلك",
  "doc.germanSummary": "بالألمانية — لإعادة إرساله إلى المورّد أو إلى Steuerberatung",
  "doc.noTemplate":
    "لا يوجد بعد نص شرح مراجَع لهذه القاعدة. أعلاه المخرجات الخام للمدقّق.",
  "doc.draft": "نص مسوّدة — لم تكتمل بعد المراجعة القانونية لهذا الشرح.",
  "doc.noFindings": "لا توجد ملاحظات.",
  "doc.evidence": "الإثبات",
  "doc.profile": "الملف التعريفي",
  "doc.received": "تاريخ الورود",
  "doc.validatorConfig": "إعدادات المدقّق",
  "doc.engine": "محرّك الفحص",
  "doc.versionsNote":
    "هذه الإصدارات جزء من الحكم، حتى يمكن تتبّعه لاحقًا.",
  "doc.layer.l1": "L1 · المخطّط (XSD)",
  "doc.layer.l2": "L2 · Schematron (KoSIT)",
  "doc.layer.l3": "L3 · الفحص الموضوعي (Belegbox)",
  "doc.layer.l4": "L4 · مجموعة قواعدك الخاصة",

  "pay.title": "تحضير الدفع",
  "pay.scan": "GiroCode — امسحه بتطبيق البنك",
  "pay.beneficiary": "المستفيد",
  "pay.iban": "IBAN",
  "pay.amount": "المبلغ",
  "pay.reference": "بيان الغرض",
  "pay.payload": "محتوى الرمز (EPC-069-12) — {bytes} بايت",

  "exp.title": "تصدير DATEV",
  "exp.sub": "دفعة قيود Buchungsstapel بصيغة EXTF، كما تستوردها Steuerberatung الخاصة بك.",
  "exp.from": "الفترة من",
  "exp.to": "إلى",
  "exp.berater": "Beraternummer",
  "exp.beraterHint":
    "هذه الأرقام تصدرها Steuerberatung الخاصة بك. بدونها لا يستطيع DATEV نسب الدفعة إلى صاحبها.",
  "exp.mandant": "Mandantennummer",
  "exp.chart": "دليل الحسابات",
  "exp.chartHint":
    "دليل الحسابات الخاطئ ينتج دفعة تضطر Steuerberatung إلى تصحيحها سطرًا سطرًا.",
  "exp.download": "تنزيل الدفعة",
  "exp.included":
    "التصدير مشمول في كل باقة مدفوعة. الملف بترميز Windows-1252 ومثبَّت نهائيًا، كما تشترط GoBD للقيود.",
  "exp.belegeTitle": "مستندات الدفعة",
  "exp.belegeSub":
    "الملفات الأصلية لنفس الفترة، بصيغة ZIP — البايتات التي وصلت بالضبط. ويُرفق فهرس يذكر لكل مستند بصمته التحقّقية ويوم أرشفته.",
  "exp.belegeDownload": "تنزيل المستندات",
  "exp.belegeHint":
    "المستندات التي لم تعد بايتاتها المخزّنة تطابق بصمتها التحقّقية المؤرشفة لا تُرفق — وتُذكر في الفهرس مع السبب.",

  "doku.sub":
    "يصف كيف تصلكم الفواتير الواردة وكيف تُفحص وكيف تُحفظ — مع بيان مصدر كل معلومة.",
  "doku.failed": "تعذّر إنشاء النسخة ({error}).",
  "doku.created": "أُنشئت النسخة {n} وحُفظت.",
  "doku.generateFirst": "أنشئ النسخة الأولى",
  "doku.generateNext": "أنشئ نسخة جديدة",
  "doku.generateHint":
    "كل نسخة تثبّت حالة النظام في لحظتها. وتبقى النسخ السابقة محفوظة.",
  "doku.openItems":
    "تتضمن النسخة {n} عدد {count} من النقاط التي لا يجيب عنها سواكم — طرق ورود أخرى، وإدارة الصندوق، وترتيب الإنابة. لا يراها Belegbox ولذلك لا يملؤها.",
  "doku.chainBroken": "سلسلة النسخ تنقطع عند النسخة {n}.",
  "doku.none": "لا توجد نسخة بعد.",
  "doku.colVersion": "النسخة",
  "doku.colDate": "بتاريخ",
  "doku.colOpen": "نقاط مفتوحة",
  "doku.colHash": "البصمة التحقّقية",
  "doku.openNone": "لا شيء",
  "doku.view": "عرض",

  "acct.sub": "اللغة والعامل الثاني ومفاتيح الوصول.",
  "acct.langTitle": "اللغة",
  "acct.langLabel": "لغة الواجهة",
  "acct.langSub":
    "تسري عليك أنت، لا على المنشأة — ومن يعمل معك في هذا الحساب يحتفظ بإعداده الخاص.",
  "acct.langSave": "حفظ اللغة",
  "acct.langSaving": "جارٍ الحفظ…",
  "acct.langSaved": "تم حفظ اللغة.",
  "acct.langExplainNote":
    "شروح نتائج الفحص متوفرة حتى الآن بالألمانية والتركية فقط. وهي نصوص مراجَعة قانونيًا ولا تُترجم آليًا — وتظهر بالألمانية في كل لغة أخرى.",
  "acct.langExplainOk": "شروح نتائج الفحص متوفرة بهذه اللغة.",
  "acct.keysTitle": "مفاتيح API",
  "acct.keysSub":
    "لربط أنظمتك الخاصة — نظام صندوق يسلّم الفواتير مثلاً. المفتاح يوثّق المنشأة لا الشخص: لا يستطيع تغيير عامل ثانٍ ولا إنشاء مفاتيح أخرى.",
  "acct.keysNone": "لا توجد مفاتيح بعد.",
  "acct.colName": "الاسم",
  "acct.colEnv": "البيئة",
  "acct.colPrefix": "المعرّف",
  "acct.colLastUsed": "آخر استخدام",
  "acct.revoke": "إبطال",
  "acct.revoked": "أُبطل في {date}",
  "acct.ownerOnly": "يدير مفاتيح API مالك الحساب.",
  "acct.newKeyTitle": "إنشاء مفتاح جديد",
  "acct.keyNameHint": "الغرض من المفتاح — يظهر في القائمة.",
  "acct.keyNamePlaceholder": "مثلاً نظام الصندوق",
  "acct.createKey": "إنشاء المفتاح",
  "acct.creatingKey": "جارٍ الإنشاء…",
  "acct.keyShown": "المفتاح «{name}»",
  "acct.keyOnce":
    "يُعرض هذا المفتاح الآن فقط. المخزَّن هو بصمته التحقّقية وحدها — ولا سبيل لرؤيته مرة أخرى. وإن ضاع فإنه يُستبدل ولا يُستعاد.",

  "mfa.title": "الدخول بعاملين",
  "mfa.codesLeft": "ما زال {n} من رموز الاسترداد غير مستخدم.",
  "mfa.codesNone":
    "لا توجد رموز استرداد مسجّلة. سيُنشأ عشرة منها عند إعادة الإعداد.",
  "mfa.passwordHint":
    "نسأل عنها مجددًا لأن بيانات الدخول نفسها هي ما يتغيّر هنا. ولا ينبغي أن تكفي جلسة مسروقة وحدها لذلك.",
  "mfa.begin": "إعادة الإعداد",
  "mfa.beginning": "جارٍ التحضير…",
  "mfa.scanTitle": "امسح الرمز الجديد",
  "mfa.scanNote":
    "أضِفه في تطبيق المصادقة، ثم أدخل الرمز الظاهر. يظل العامل الثاني الحالي ساريًا حتى يُؤكَّد الجديد.",
  "mfa.orLink": "أو افتح هذا الرابط في التطبيق:",
  "mfa.codeLabel": "الرمز من التطبيق",
  "mfa.confirm": "تأكيد",
  "mfa.confirming": "جارٍ الفحص…",
  "mfa.recoveryTitle": "رموز الاسترداد",
  "mfa.recoveryNote":
    "كل رمز يعمل مرة واحدة بدلاً من رمز التطبيق. وتُعرض الآن فقط — اطبعها أو ضعها في مدير كلمات المرور. وقد أُنهيت جميع الجلسات الأخرى.",

  "setup.title": "الإعداد",
  "setup.sub": "ثلاث معلومات، دون بطاقة ائتمان. وفي النهاية يكون لديك عنوانك للفواتير الإلكترونية.",
  "setup.warn":
    "منذ ١ يناير ٢٠٢٥ يحق للموردين إرسال فواتير إلكترونية دون سؤال مسبق. لذلك يسري واجب استلامها وأرشفتها بصورة مقروءة من اليوم — بصرف النظر عن الموعد الذي يلزمك أنت فيه بإصدار فواتير إلكترونية.",
  "setup.name": "اسم الشركة",
  "setup.nameHint": "يُحلّ الشكل القانوني وحروف العلة الألمانية تلقائيًا لأجل العنوان.",
  "setup.taxId": "USt-IdNr. أو Steuernummer",
  "setup.industry": "القطاع",
  "setup.industryHint":
    "يحدّد مجموعة القواعد التي تُفحص بها الفواتير الواردة من حيث المضمون.",
  "setup.chooseSector": "اختر من فضلك",
  "setup.sector.gastro": "المطاعم والضيافة",
  "setup.sector.handwerk": "الحِرف والبناء",
  "setup.sector.logistik": "الخدمات اللوجستية والنقل",
  "setup.sector.handel": "التجارة",
  "setup.sector.frei": "المهن الحرة والوكالات",
  "setup.language": "اللغة",
  "setup.submit": "ابدأ الإعداد",
  "setup.submitting": "جارٍ الإعداد …",

  "done.title": "أوشكت على الانتهاء.",
  "done.sub": "بقيت خطوة واحدة: الدخول بعاملين إلى حسابك.",
  "done.warn":
    "يُعرض هذا المفتاح الآن فقط. أدخِله في تطبيق المصادقة قبل أن تكمل — فبدونه لن تدخل حسابك.",
  "done.secretLabel": "مفتاح تطبيق المصادقة",
  "done.secretNote":
    "تطبيقات مثل Aegis أو 1Password أو Google Authenticator تقبل هذا المفتاح مباشرة. وعند أول دخول نسألك عن الرمز المكوّن من ستة أرقام منه.",
  "done.addressLabel": "عنوان الفواتير",
  "done.addressNote":
    "اللاحقة العشوائية جزء من العنوان. فهي تمنع أن يخمّن أحد العنوان من اسم شركتك ويرسل إليك فاتورة مزوّرة.",
  "done.noticeLabel": "نص لمورّديك — بالألمانية، لأنه موجَّه إليهم",
  "done.signIn": "سجّل الدخول الآن",

  "reset.title": "إعادة تعيين كلمة المرور",
  "reset.sub": "سنرسل إليك رابطًا تضبط به كلمة مرور جديدة.",
  "reset.backToLogin": "العودة إلى تسجيل الدخول",
  "reset.request": "اطلب الرابط",
  "reset.requesting": "جارٍ الإرسال …",
  "reset.sent":
    "إن كان لهذا العنوان حساب، فرسالة في طريقها إليك. الرابط صالح ساعة واحدة ويعمل مرة واحدة.",
  "reset.devLink": "وضع التطوير — يُسلَّم الرابط عادةً بالبريد الإلكتروني",
  "reset.newTitle": "كلمة مرور جديدة",
  "reset.newSub":
    "بعد ذلك يُنهى دخولك على كل الأجهزة — بما فيها تلك التي ربما لم تكن أنت عليها.",
  "reset.newPassword": "كلمة المرور الجديدة",
  "reset.repeat": "مرة أخرى",
  "reset.save": "احفظ كلمة المرور",
  "reset.saving": "جارٍ الحفظ …",

  // See the note on these in de.ts.
  "err.needPassword": "أدخل كلمة المرور الحالية من فضلك.",
  "err.needCode": "أدخل الرمز من التطبيق من فضلك.",
  "err.needName": "أعطِه اسمًا من فضلك.",
  "err.mfa.invalid_code": "الرمز غير مطابق. يتغيّر كل ٣٠ ثانية.",
  "err.mfa.expired": "انتهت صلاحية الإعداد. ابدأ من جديد من فضلك.",
  "err.mfa.no_pending_secret": "لا يوجد إعداد جارٍ الآن. ابدأ من جديد من فضلك.",
  "err.language": "تعذّر حفظ هذه اللغة.",
  "err.credentials": "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
  "err.needEmailPassword": "أدخل البريد الإلكتروني وكلمة المرور.",
  "err.emailInvalid": "أدخل بريدًا إلكترونيًا صالحًا.",
  "err.needCompanyName": "أدخل اسم الشركة.",
  "err.passwordTooShort": "كلمة المرور تحتاج ١٢ حرفًا على الأقل. الطول أهم من الرموز الخاصة.",
  "err.passwordMismatch": "كلمتا المرور غير متطابقتين.",
  "err.mfa_enrollment_required": "هذا الحساب يتطلّب الدخول بعاملين، لكن إعداده لم يكتمل. تواصل مع مالك الحساب من فضلك.",
  "err.reset.linkSpent": "انتهت صلاحية هذا الرابط أو استُخدم من قبل. اطلب رابطًا جديدًا.",
  "err.reset.failed": "لم ينجح ذلك الآن. حاول مرة أخرى من فضلك.",
  "err.upload.noFile": "اختر ملفًا من فضلك.",
  "err.upload.empty": "الملف فارغ.",
  "err.upload.failed": "لم ينجح الرفع.",
  "err.periodRequired": "حدّد فترة من فضلك.",
  "err.datevRequired": "الفترة وBeraternummer وMandantennummer مطلوبة.",
  "err.doku.badVersion": "نسخة غير صالحة.",
  "err.doku.notFound": "لا توجد هذه النسخة.",
  "doc.rawLabel": "نص الفحص كما ورد",
  "doc.rawNote": "أدوات الفحص تصوغ هذا بنفسها — ومدقّق KoSIT الرسمي بالإنجليزية غالبًا. يُنقل النص حرفيًا ولا يُترجم، ليطابق ما يراه مورّدك لديه.",
  "doc.explanationPending": "شرح هذه القاعدة مكتوب لكنه لم يجتز المراجعة القانونية بعد، ولذلك لا يُعرض.",
  "doc.technicalDetails": "قيم تقنية من الفحص",
  "doc.explanationLanguage": "هذا الشرح بالألمانية — لا يوجد بعد نص مراجَع قانونيًا بالعربية.",
};
