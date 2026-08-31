package de.belegbox.mustang;

import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import javax.xml.XMLConstants;
import javax.xml.stream.XMLInputFactory;
import javax.xml.stream.XMLStreamConstants;
import javax.xml.stream.XMLStreamReader;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.Schema;
import javax.xml.validation.SchemaFactory;
import javax.xml.validation.Validator;
import org.xml.sax.ErrorHandler;
import org.xml.sax.SAXParseException;

/**
 * L1 (XSD) today, L2 (KoSIT Schematron) in F1 week 2-3.
 *
 * Both the StAX reader and the XSD validator are configured to refuse DTDs and
 * external entities. Inbound documents arrive by email from anyone who learns
 * the address, so XXE is a live attack path, not a theoretical one.
 */
public final class Validators {

    public record Finding(String layer, String code, String severity, String btRef, String message) {
    }

    public record LayerOutcome(boolean ran, boolean valid, String skippedReason) {
    }

    public record Result(LayerOutcome l1, LayerOutcome l2, List<Finding> findings) {
    }

    private static final String L2_PENDING =
            "L2 Schematron is not wired yet - de.kosit:validationtool lands in F1 week 2-3.";

    private final Path schemaDir;

    public Validators(Path schemaDir) {
        this.schemaDir = schemaDir;
    }

    public Result validate(byte[] document) {
        List<Finding> findings = new ArrayList<>();
        LayerOutcome l1 = runXsd(document, findings);
        LayerOutcome l2 = new LayerOutcome(false, false, L2_PENDING);
        return new Result(l1, l2, findings);
    }

    /** Root element local name, used to pick the schema. */
    static String rootElement(byte[] document) throws Exception {
        XMLInputFactory factory = XMLInputFactory.newInstance();
        factory.setProperty(XMLInputFactory.SUPPORT_DTD, Boolean.FALSE);
        factory.setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, Boolean.FALSE);
        XMLStreamReader reader = factory.createXMLStreamReader(new ByteArrayInputStream(document));
        try {
            while (reader.hasNext()) {
                if (reader.next() == XMLStreamConstants.START_ELEMENT) {
                    return reader.getLocalName();
                }
            }
        } finally {
            reader.close();
        }
        return "";
    }

    private Path schemaFor(String root) {
        return switch (root) {
            case "Invoice" -> schemaDir.resolve("ubl/maindoc/UBL-Invoice-2.1.xsd");
            case "CreditNote" -> schemaDir.resolve("ubl/maindoc/UBL-CreditNote-2.1.xsd");
            case "CrossIndustryInvoice" -> schemaDir.resolve("cii/CrossIndustryInvoice_100pD16B.xsd");
            default -> null;
        };
    }

    private LayerOutcome runXsd(byte[] document, List<Finding> findings) {
        String root;
        try {
            root = rootElement(document);
        } catch (Exception e) {
            findings.add(new Finding("l1_schema", "L1-PARSE", "error", null,
                    "Document is not well-formed XML: " + e.getMessage()));
            return new LayerOutcome(true, false, null);
        }

        Path xsd = schemaFor(root);
        if (xsd == null) {
            findings.add(new Finding("l1_schema", "L1-ROOT", "error", null,
                    "Unknown root element <" + root + ">. Expected Invoice, CreditNote or CrossIndustryInvoice."));
            return new LayerOutcome(true, false, null);
        }
        if (!Files.isReadable(xsd)) {
            // Honest degradation: an unavailable schema is not a passing document.
            return new LayerOutcome(false, false,
                    "Schema not vendored: " + xsd + ". See services/mustang-svc/README.md.");
        }

        try {
            SchemaFactory sf = SchemaFactory.newInstance(XMLConstants.W3C_XML_SCHEMA_NS_URI);
            sf.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
            // Local includes and imports must still resolve; remote ones must not.
            sf.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "file");
            Schema schema = sf.newSchema(xsd.toFile());

            Validator validator = schema.newValidator();
            validator.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
            validator.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
            validator.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);

            List<Finding> errors = new ArrayList<>();
            validator.setErrorHandler(new ErrorHandler() {
                @Override
                public void warning(SAXParseException e) {
                    errors.add(finding("warning", e));
                }

                @Override
                public void error(SAXParseException e) {
                    errors.add(finding("error", e));
                }

                @Override
                public void fatalError(SAXParseException e) {
                    errors.add(finding("error", e));
                }

                private Finding finding(String severity, SAXParseException e) {
                    return new Finding("l1_schema", "L1-XSD", severity, null,
                            "line " + e.getLineNumber() + ", column " + e.getColumnNumber()
                                    + ": " + e.getMessage());
                }
            });

            validator.validate(new StreamSource(new ByteArrayInputStream(document)));
            findings.addAll(errors);
            boolean valid = errors.stream().noneMatch(f -> "error".equals(f.severity()));
            return new LayerOutcome(true, valid, null);
        } catch (Exception e) {
            findings.add(new Finding("l1_schema", "L1-XSD", "error", null,
                    "Schema validation failed: " + e.getMessage()));
            return new LayerOutcome(true, false, null);
        }
    }
}
