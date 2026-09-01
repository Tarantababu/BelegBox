package de.belegbox.mustang;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;

/**
 * Requirement R-2. The service reports the exact versions that produced a
 * verdict, and the caller stores them on every finding.
 */
public final class Versions {

    private static final Properties PROPS = load();

    private Versions() {
    }

    private static Properties load() {
        Properties p = new Properties();
        try (InputStream in = Versions.class.getClassLoader()
                .getResourceAsStream("versions.properties")) {
            if (in != null) {
                p.load(in);
            }
        } catch (IOException e) {
            // A missing pin must be loud, but it must not stop the service from
            // starting - the caller sees UNPINNED and can act on it.
            System.err.println("Cannot read versions.properties: " + e.getMessage());
        }
        return p;
    }

    public static String validatorConfigVersion() {
        return PROPS.getProperty("validator.config.version", "UNPINNED");
    }

    public static String mustangVersion() {
        return PROPS.getProperty("mustang.library.version", "UNPINNED");
    }

    public static String kositVersion() {
        return PROPS.getProperty("kosit.validationtool.version", "UNPINNED");
    }

    /**
     * The digest of the validator configuration this service is running.
     *
     * Reported rather than left to the caller because the caller cannot see
     * which configuration was actually loaded. The Verfahrensdokumentation
     * states this digest as evidence of what "formally correct" meant on the
     * day a document was judged, so it has to come from the process holding the
     * files, not from a constant compiled in somewhere else.
     */
    public static String validatorConfigSha256() {
        return PROPS.getProperty("validator.config.sha256", "UNPINNED");
    }
}
