package de.belegbox.mustang;

import de.kosit.validationtool.api.Check;
import de.kosit.validationtool.api.Configuration;
import de.kosit.validationtool.api.Input;
import de.kosit.validationtool.api.InputFactory;
import de.kosit.validationtool.api.Result;
import de.kosit.validationtool.api.XmlError;
import de.kosit.validationtool.impl.DefaultCheck;
import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import javax.xml.transform.stream.StreamSource;
import net.sf.saxon.s9api.Processor;
import org.oclc.purl.dsdl.svrl.FailedAssert;

/**
 * L1 and L2, run by the official KoSIT validator.
 *
 * Both layers come from one engine because the configuration defines both: the
 * scenario picks the XSD for the document's syntax and the Schematron for its
 * CIUS. Splitting them would mean choosing our own schema for L1 and hoping it
 * matched the one L2 assumed.
 *
 * This is the same engine the ZRE and OZG-RE portals run. A document that
 * passes here passes there, which is what makes "the official validator" a
 * statement of fact rather than a marketing line.
 */
public final class Validators {

    public record Finding(String layer, String code, String severity, String btRef, String message) {
    }

    public record LayerOutcome(boolean ran, boolean valid, String skippedReason) {
    }

    public record Result2(LayerOutcome l1, LayerOutcome l2, List<Finding> findings) {
    }

    private final Path configDir;
    private volatile Check check;
    private volatile String unavailableReason;

    public Validators(Path configDir) {
        this.configDir = configDir;
        initialise();
    }

    /**
     * Loads the scenario configuration once, at construction.
     *
     * Compiling the Schematron is expensive and the result is immutable, so it
     * happens at boot rather than per request. A configuration that cannot load
     * leaves the service running and every response saying why - the ingest
     * pipeline degrades to "form verdict unknown", which is the honest answer,
     * instead of the process refusing to start and taking receiving down with
     * it.
     */
    private void initialise() {
        Path scenarios = configDir.resolve("scenarios.xml");
        if (!Files.isReadable(scenarios)) {
            this.unavailableReason = "Validator configuration not installed at " + scenarios
                    + ". Run services/mustang-svc/scripts/fetch-validator-config.sh.";
            return;
        }
        try {
            // A licence-free Saxon-HE processor. The engine needs one to compile the
            // Schematron, and sharing a single instance keeps that cost at boot.
            Processor processor = new Processor(false);
            Configuration configuration = Configuration.load(scenarios.toUri()).build(processor);
            this.check = new DefaultCheck(processor, configuration);
            System.out.println("  scenarios        : " + configuration.getName());
        } catch (Exception e) {
            this.unavailableReason = "Validator configuration failed to load: " + e.getMessage();
            System.err.println(this.unavailableReason);
        }
    }

    public boolean isReady() {
        return check != null;
    }

    public String unavailableReason() {
        return unavailableReason;
    }

    public Result2 validate(byte[] document) {
        if (check == null) {
            LayerOutcome skipped = new LayerOutcome(false, false, unavailableReason);
            return new Result2(skipped, skipped, List.of());
        }

        List<Finding> findings = new ArrayList<>();
        Result result;
        try {
            Input input = InputFactory.read(
                    new StreamSource(new ByteArrayInputStream(document)), "document");
            result = check.checkInput(input);
        } catch (Exception e) {
            findings.add(new Finding("l1_schema", "L1-PARSE", "error", null,
                    "Document could not be read: " + e.getMessage()));
            return new Result2(new LayerOutcome(true, false, null),
                    new LayerOutcome(false, false, "Schema check did not complete."),
                    findings);
        }

        if (!result.isWellformed()) {
            findings.add(new Finding("l1_schema", "L1-WELLFORMED", "error", null,
                    "Document is not well-formed XML."));
            return new Result2(new LayerOutcome(true, false, null),
                    new LayerOutcome(false, false, "Document is not well-formed."),
                    findings);
        }

        // The engine returns null, not an empty list, when a check produced
        // nothing. Every list it hands back is treated as nullable.
        // A document that matches no scenario never reaches schema validation:
        // the engine falls back and reports "not valid" with nothing to show.
        // Saying so is the difference between a usable finding and a dead end.
        for (String processingError : orEmpty(result.getProcessingErrors())) {
            findings.add(new Finding("l1_schema", "L1-SCENARIO", "error", null, processingError));
        }

        for (XmlError error : orEmpty(result.getSchemaViolations())) {
            findings.add(new Finding("l1_schema", "L1-XSD", severityOf(error), null,
                    location(error) + error.getMessage()));
        }
        boolean schemaValid = result.isSchemaValid();

        if (Boolean.getBoolean("belegbox.dumpReport")) {
            System.err.println(reportXml(result));
        }

        // Schematron only runs on a schema-valid document; the KoSIT engine
        // reports it as valid-by-default otherwise, which would read as a pass.
        LayerOutcome l2;
        if (!schemaValid) {
            l2 = new LayerOutcome(false, false,
                    "Schematron not evaluated: the document failed schema validation.");
        } else {
            for (FailedAssert assertion : orEmpty(result.getFailedAsserts())) {
                findings.add(toFinding(assertion));
            }
            l2 = new LayerOutcome(true, result.isSchematronValid(), null);
        }

        return new Result2(new LayerOutcome(true, schemaValid, null), l2, findings);
    }

    /** The validator's own report, for diagnosing a verdict we did not expect. */
    static String reportXml(Result result) {
        try {
            var transformer = javax.xml.transform.TransformerFactory.newInstance().newTransformer();
            transformer.setOutputProperty(javax.xml.transform.OutputKeys.INDENT, "yes");
            var writer = new java.io.StringWriter();
            transformer.transform(
                    new javax.xml.transform.dom.DOMSource(result.getReportDocument()),
                    new javax.xml.transform.stream.StreamResult(writer));
            return writer.toString();
        } catch (Exception e) {
            return "<!-- report unavailable: " + e.getMessage() + " -->";
        }
    }

    private static <T> List<T> orEmpty(List<T> list) {
        return list == null ? List.of() : list;
    }

    private static String severityOf(XmlError error) {
        return error.getSeverity() == XmlError.Severity.SEVERITY_WARNING ? "warning" : "error";
    }

    private static String location(XmlError error) {
        if (error.getRowNumber() == null) {
            return "";
        }
        return "line " + error.getRowNumber()
                + (error.getColumnNumber() == null ? "" : ", column " + error.getColumnNumber())
                + ": ";
    }

    /**
     * Maps one failed Schematron assertion.
     *
     * The message is kept exactly as the validator emitted it. It is shown to
     * the user beside the plain-language explanation, and an auditor comparing
     * our output to a portal's has to see the same string.
     */
    private static Finding toFinding(FailedAssert assertion) {
        String code = assertion.getId() == null ? "BR-UNKNOWN" : assertion.getId();
        String message = assertion.getText() == null
                || assertion.getText().getContent() == null
                || assertion.getText().getContent().isEmpty()
                ? assertion.getTest()
                : String.join(" ", assertion.getText().getContent().stream()
                        .map(Object::toString).map(String::trim).toList()).trim();

        // "fatal" is the KoSIT flag for a rule that invalidates the document;
        // "warning" leaves it usable. Anything else is treated as an error,
        // because guessing downwards would turn a real defect into a note.
        String severity = "warning".equalsIgnoreCase(assertion.getFlag()) ? "warning" : "error";

        return new Finding("l2_schematron", code, severity, btRef(message), message);
    }

    /** Pulls the first EN 16931 business term out of a rule message, e.g. BT-112. */
    private static String btRef(String message) {
        if (message == null) {
            return null;
        }
        var matcher = java.util.regex.Pattern.compile("\\b(B[TG]-\\d+)\\b").matcher(message);
        return matcher.find() ? matcher.group(1) : null;
    }
}
