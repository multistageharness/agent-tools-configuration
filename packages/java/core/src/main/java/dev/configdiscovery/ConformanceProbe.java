package dev.configdiscovery;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The conformance probe - the adapter between {@code packages/spec/PROBE.md} and
 * {@link ConfigDiscovery#load}.
 *
 * <p>Packaged as a fat jar and run with {@code java -jar}: seventeen fixtures times a cold JVM
 * plus a Gradle daemon check is slow enough that people stop running the suite.
 */
public final class ConformanceProbe {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** SPEC section 6. Anything outside this set exits 2 rather than being quietly ignored. */
    private static final Set<String> KNOWN_OPTIONS =
            Set.of("strategy", "arrayMerge", "stopDir", "envPrefix", "profile", "strict", "defaults", "overrides");

    private ConformanceProbe() {}

    /** Entry point. Exit 0 result, 1 the library rejected the input, 2 the harness is broken. */
    public static void main(String[] argv) {
        System.exit(run(argv));
    }

    static int run(String[] argv) {
        String packageName = null;
        Path cwd = null;
        Path home = null;
        Path fixtureRoot = null;
        Map<String, String> env = new LinkedHashMap<>();
        ObjectNode options = JsonNodeFactory.instance.objectNode();

        try {
            for (int index = 0; index < argv.length; index++) {
                String flag = argv[index];
                switch (flag) {
                    case "--package-name" -> packageName = value(argv, ++index, flag);
                    case "--cwd" -> cwd = Path.of(value(argv, ++index, flag));
                    case "--home" -> home = Path.of(value(argv, ++index, flag));
                    case "--fixture-root" -> fixtureRoot = Path.of(value(argv, ++index, flag));
                    case "--env" -> {
                        String pair = value(argv, ++index, flag);
                        int equals = pair.indexOf('=');
                        if (equals < 1) {
                            throw new IllegalArgumentException("--env expects KEY=VALUE, got " + pair);
                        }
                        env.put(pair.substring(0, equals), pair.substring(equals + 1));
                    }
                    case "--options" -> {
                        JsonNode parsed = MAPPER.readTree(value(argv, ++index, flag));
                        if (!parsed.isObject()) {
                            throw new IllegalArgumentException("--options must be a JSON object");
                        }
                        options = (ObjectNode) parsed;
                    }
                    default -> throw new IllegalArgumentException("unknown flag \"" + flag + "\"");
                }
            }
            if (packageName == null || cwd == null || home == null || fixtureRoot == null) {
                throw new IllegalArgumentException(
                        "missing one of --package-name, --cwd, --home, --fixture-root");
            }
            options.fieldNames().forEachRemaining(name -> {
                if (!KNOWN_OPTIONS.contains(name)) {
                    throw new IllegalArgumentException("unsupported option \"" + name + "\" (SPEC section 6)");
                }
            });
        } catch (Exception badUsage) {
            System.err.println(badUsage.getMessage());
            return 2;
        }

        Path root = fixtureRoot.toAbsolutePath().normalize();
        try {
            LoadOptions.Builder builder = LoadOptions.builder()
                    .cwd(cwd)
                    .home(home)
                    // Built only from --env. Never System.getenv(): this is the line that stops a
                    // developer's exported MYTOOL_LOG__LEVEL changing fixture results.
                    .env(env)
                    .relativeTo(root)
                    .warningHandler(System.err::println);
            applyOptions(builder, options);

            Loaded loaded = ConfigDiscovery.load(packageName, builder.build());
            ObjectNode document = JsonNodeFactory.instance.objectNode();
            document.set("config", loaded.config());
            document.put("found", loaded.found());
            document.set("sources", MAPPER.valueToTree(loaded.sources()));
            System.out.print(MAPPER.writeValueAsString(document));
            return 0;
        } catch (ConfigException failure) {
            ObjectNode error = JsonNodeFactory.instance.objectNode();
            error.put("kind", failure.kind().wireName());
            if (failure.path() != null) {
                error.put("path", Sources.rewrite(failure.path(), root));
            }
            if (failure.keyPath() != null) {
                error.put("keyPath", failure.keyPath());
            }
            error.put("message", failure.getMessage());
            ObjectNode document = JsonNodeFactory.instance.objectNode();
            document.set("error", error);
            System.out.print(document);
            return 1;
        } catch (Throwable crash) {
            // Not a ConfigException: this harness is broken, not the library rejecting input.
            crash.printStackTrace(System.err);
            return 2;
        }
    }

    private static void applyOptions(LoadOptions.Builder builder, ObjectNode options) {
        if (options.has("strategy")) {
            builder.strategy(Merge.Strategy.valueOf(
                    options.get("strategy").asText().toUpperCase(Locale.ROOT).replace('-', '_')));
        }
        if (options.has("arrayMerge")) {
            builder.arrayMerge(Merge.ArrayMerge.valueOf(options.get("arrayMerge").asText().toUpperCase(Locale.ROOT)));
        }
        if (options.has("stopDir")) {
            builder.stopDir(Path.of(options.get("stopDir").asText()));
        }
        if (options.has("envPrefix")) {
            builder.envPrefix(options.get("envPrefix").asText());
        }
        if (options.has("profile")) {
            builder.profile(options.get("profile").asText());
        }
        if (options.has("strict")) {
            builder.strict(options.get("strict").asBoolean());
        }
        if (options.has("defaults") && options.get("defaults").isObject()) {
            builder.defaults((ObjectNode) options.get("defaults"));
        }
        if (options.has("overrides") && options.get("overrides").isObject()) {
            builder.overrides((ObjectNode) options.get("overrides"));
        }
    }

    private static String value(String[] argv, int index, String flag) {
        if (index >= argv.length) {
            throw new IllegalArgumentException(flag + " requires a value");
        }
        return argv[index];
    }

    /** Unused, but keeps the compiler honest about the imports this class needs. */
    static List<String> formats() {
        return List.of("toml", "yaml", "json", "jsonc", "ini", "dotenv");
    }
}
