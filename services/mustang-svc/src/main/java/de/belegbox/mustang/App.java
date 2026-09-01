package de.belegbox.mustang;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.Executors;

public final class App {

    /** Refuse oversized bodies before allocating for them. */
    private static final int MAX_BODY_BYTES = 32 * 1024 * 1024;

    public static void main(String[] args) throws IOException {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8081"));
        Path configDir = Path.of(System.getenv().getOrDefault("VALIDATOR_CONFIG_DIR", "validator-config"));
        Validators validators = new Validators(configDir);

        // Bound explicitly, not with the wildcard constructor.
        //
        // Fly's private network is IPv6 only, and a service reachable as
        // <app>.internal has to be listening on an IPv6 address. The wildcard
        // form usually gives a dual-stack socket, but "usually" depends on the
        // JVM's IPv6 support in the container, and the failure mode is a
        // validator that starts, answers health checks, and cannot be reached
        // by the API at all.
        String bind = System.getenv().getOrDefault("BIND_ADDR", "::");
        HttpServer server = HttpServer.create(new InetSocketAddress(bind, port), 0);
        server.createContext("/health", ex -> respond(ex, 200,
                "{\"status\":\"ok\","
                        + "\"validatorConfigVersion\":" + Json.string(Versions.validatorConfigVersion()) + ","
                        + "\"validatorConfigSha256\":" + Json.string(Versions.validatorConfigSha256()) + ","
                        + "\"kositVersion\":" + Json.string(Versions.kositVersion()) + ","
                        + "\"mustangVersion\":" + Json.string(Versions.mustangVersion()) + "}"));
        // com.sun.net.httpserver swallows a handler exception and closes the
        // connection with no response and no log line. The caller sees "empty
        // reply from server" and has nothing to go on, so every handler is
        // wrapped.
        server.createContext("/validate", ex -> {
            try {
                handleValidate(ex, validators);
            } catch (Throwable t) {
                System.err.println("validate failed: " + t);
                t.printStackTrace();
                try {
                    respond(ex, 500, "{\"error\":" + Json.string(String.valueOf(t)) + "}");
                } catch (IOException ignored) {
                    // The connection is already gone; the stack trace above is
                    // the record that matters.
                }
            }
        });
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());

        // Printed at boot so the pinned configuration is visible in the logs of
        // every environment that ever produced a verdict (R-2).
        System.out.println("mustang-svc listening on [" + bind + "]:" + port);
        System.out.println("  validator config : " + Versions.validatorConfigVersion());
        System.out.println("  mustang library  : " + Versions.mustangVersion());
        System.out.println("  config dir       : " + configDir.toAbsolutePath());
        if (!validators.isReady()) {
            System.out.println("  WARNING          : " + validators.unavailableReason());
        }
        server.start();
    }

    private static void handleValidate(HttpExchange ex, Validators validators) throws IOException {
        if (!"POST".equals(ex.getRequestMethod())) {
            respond(ex, 405, "{\"error\":\"use POST\"}");
            return;
        }

        byte[] body;
        try (var in = ex.getRequestBody()) {
            body = in.readNBytes(MAX_BODY_BYTES + 1);
        }
        if (body.length > MAX_BODY_BYTES) {
            respond(ex, 413, "{\"error\":\"document exceeds 32 MB\"}");
            return;
        }
        if (body.length == 0) {
            respond(ex, 400, "{\"error\":\"empty body - send the raw document bytes\"}");
            return;
        }

        Validators.Result2 result = validators.validate(body);
        respond(ex, 200, render(result));
    }

    private static String render(Validators.Result2 r) {
        StringBuilder sb = new StringBuilder(512);
        sb.append('{')
                .append("\"validatorConfigVersion\":").append(Json.string(Versions.validatorConfigVersion())).append(',')
                .append("\"mustangVersion\":").append(Json.string(Versions.mustangVersion())).append(',')
                .append("\"l1\":").append(layer(r.l1())).append(',')
                .append("\"l2\":").append(layer(r.l2())).append(',')
                .append("\"findings\":").append(findings(r.findings()))
                .append('}');
        return sb.toString();
    }

    private static String layer(Validators.LayerOutcome o) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"ran\":").append(o.ran()).append(",\"valid\":").append(o.valid());
        if (o.skippedReason() != null) {
            sb.append(",\"skippedReason\":").append(Json.string(o.skippedReason()));
        }
        return sb.append('}').toString();
    }

    private static String findings(List<Validators.Finding> findings) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < findings.size(); i++) {
            Validators.Finding f = findings.get(i);
            if (i > 0) {
                sb.append(',');
            }
            sb.append('{')
                    .append("\"layer\":").append(Json.string(f.layer())).append(',')
                    .append("\"code\":").append(Json.string(f.code())).append(',')
                    .append("\"severity\":").append(Json.string(f.severity())).append(',');
            if (f.btRef() != null) {
                sb.append("\"btRef\":").append(Json.string(f.btRef())).append(',');
            }
            sb.append("\"message\":").append(Json.string(f.message())).append('}');
        }
        return sb.append(']').toString();
    }

    private static void respond(HttpExchange ex, int status, String json) throws IOException {
        byte[] out = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(status, out.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(out);
        }
    }
}
