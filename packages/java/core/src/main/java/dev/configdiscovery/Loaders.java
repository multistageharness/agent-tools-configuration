package dev.configdiscovery;

import com.fasterxml.jackson.core.JsonLocation;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.json.JsonReadFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.dataformat.toml.TomlMapper;
import com.fasterxml.jackson.dataformat.yaml.YAMLMapper;
import io.github.cdimascio.dotenv.Dotenv;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * File loading - where Jackson earns its place.
 *
 * <p>Every dataformat module returns the same tree type, {@link JsonNode}, so the merge in
 * {@link Merge} is written once rather than per format. That is a real advantage over the other
 * four language packages, each of which had to normalize its parsers' output first.
 *
 * <p>Two format notes worth knowing before editing:
 *
 * <ul>
 *   <li>{@code .jsonc} uses {@link JsonReadFeature#ALLOW_JAVA_COMMENTS} rather than a hand-rolled
 *       comment stripper. Every other language in this repository ships a stripper; this one does
 *       not need to, and that is most of why Jackson is the right choice here.
 *   <li>{@code .env} uses dotenv-java, but only its <em>declared</em> entries: dotenv-java merges
 *       {@code System.getenv()} into its result by default, which would silently break every
 *       fixture and make results depend on the developer's shell.
 * </ul>
 */
public final class Loaders {

    private static final TomlMapper TOML = TomlMapper.builder().build();
    private static final YAMLMapper YAML = YAMLMapper.builder().build();
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final JsonMapper JSONC = JsonMapper.builder()
            .enable(JsonReadFeature.ALLOW_JAVA_COMMENTS)
            .enable(JsonReadFeature.ALLOW_TRAILING_COMMA)
            .build();

    /** SPEC section 2.5: the closed, ordered list. Also the load order, later entries winning. */
    public static final List<String[]> RECOGNIZED_FILES = List.of(
            new String[] {"config.toml", "toml"},
            new String[] {"config.yaml", "yaml"},
            new String[] {"config.yml", "yaml"},
            new String[] {"config.json", "json"},
            new String[] {"config.jsonc", "jsonc"},
            new String[] {"config.ini", "ini"},
            new String[] {".env", "dotenv"});

    private Loaders() {}

    /** A recognized configuration file and the format it is read as. */
    public record FileRef(Path path, String format) {}

    /** The recognized files present in one config directory, in SPEC section 2.5 order. */
    public static List<FileRef> listConfigFiles(Path root, String profile) {
        // SPEC section 2.5: a mistake, not an intention. Picking a winner silently would hide it.
        if (Files.exists(root.resolve("config.yaml")) && Files.exists(root.resolve("config.yml"))) {
            throw ConfigException.of(
                    ConfigException.Kind.DUPLICATE_FORMAT,
                    root.toString(),
                    "config.yaml and config.yml cannot both be present",
                    null);
        }

        List<FileRef> files = new ArrayList<>();
        for (String[] entry : RECOGNIZED_FILES) {
            String name = entry[0];
            String format = entry[1];
            Path path = root.resolve(name);
            if (Files.exists(path)) {
                files.add(new FileRef(path, format));
            }
            if (profile != null && !profile.isBlank()) {
                // SPEC section 2.6: config.<profile>.<ext> immediately after its base file.
                Path profiled = root.resolve(withProfile(name, profile));
                if (Files.exists(profiled)) {
                    files.add(new FileRef(profiled, format));
                }
            }
        }
        return List.copyOf(files);
    }

    private static String withProfile(String name, String profile) {
        int dot = name.lastIndexOf('.');
        return dot <= 0
                ? name + "." + profile
                : name.substring(0, dot) + "." + profile + name.substring(dot);
    }

    /** Read one file into an {@link ObjectNode} with its original key case intact. */
    public static ObjectNode loadOne(FileRef file, String envPrefix) {
        String text = read(file.path());
        if (text.isBlank()) {
            return JsonNodeFactory.instance.objectNode();
        }
        return switch (file.format()) {
            case "toml" -> tree(TOML, text, file.path());
            case "yaml" -> tree(YAML, text, file.path());
            case "json" -> tree(JSON, text, file.path());
            case "jsonc" -> tree(JSONC, text, file.path());
            case "ini" -> parseIni(text);
            case "dotenv" -> parseDotenv(file.path(), envPrefix);
            default -> throw ConfigException.of(
                    ConfigException.Kind.MALFORMED, file.path().toString(), "unhandled format " + file.format(), null);
        };
    }

    private static String read(Path path) {
        try {
            return Files.readString(path, StandardCharsets.UTF_8);
        } catch (IOException cause) {
            // Permission, a directory where a file belongs, an IO fault: a read failure, never a
            // parse failure. SPEC section 5 keeps those kinds apart.
            throw ConfigException.of(
                    ConfigException.Kind.UNREADABLE, path.toString(), cause.toString(), cause);
        }
    }

    private static ObjectNode tree(ObjectMapper mapper, String text, Path path) {
        // readTree(String) only throws JsonProcessingException: the bytes are already in hand, so
        // there is no IO left to fail.
        try {
            JsonNode node = mapper.readTree(text);
            if (node == null || node.isNull() || node.isMissingNode()) {
                return JsonNodeFactory.instance.objectNode();
            }
            if (!node.isObject()) {
                throw ConfigException.of(
                        ConfigException.Kind.MALFORMED,
                        path.toString(),
                        "top level must be a table, not " + node.getNodeType(),
                        null);
            }
            return (ObjectNode) EnvLayer.normalizeNumbers(node);
        } catch (JsonProcessingException cause) {
            JsonLocation location = cause.getLocation();
            int line = location == null ? 0 : location.getLineNr();
            int column = location == null ? 0 : location.getColumnNr();
            throw ConfigException.malformed(path.toString(), line, column, cause.getOriginalMessage(), cause);
        }
    }

    /**
     * A small INI reader: {@code [section]} headers, {@code key = value}, {@code #} and {@code ;}
     * comments. Jackson has no INI dataformat.
     *
     * <p>INI is untyped, so SPEC section 2.5 pins the same coercion the env layer uses.
     */
    public static ObjectNode parseIni(String text) {
        ObjectNode root = JsonNodeFactory.instance.objectNode();
        ObjectNode table = root;
        String[] lines = text.split("\r?\n", -1);
        for (int index = 0; index < lines.length; index++) {
            String line = lines[index].trim();
            if (line.isEmpty() || line.startsWith("#") || line.startsWith(";")) {
                continue;
            }
            if (line.startsWith("[")) {
                if (!line.endsWith("]")) {
                    throw ConfigException.malformed("", index + 1, 0, "unterminated section header", null);
                }
                table = root.putObject(line.substring(1, line.length() - 1).trim());
                continue;
            }
            int equals = line.indexOf('=');
            if (equals < 1) {
                throw ConfigException.malformed("", index + 1, 0, "expected key = value", null);
            }
            String value = line.substring(equals + 1).trim();
            boolean quoted = value.length() >= 2
                    && (value.charAt(0) == '"' || value.charAt(0) == '\'')
                    && value.charAt(value.length() - 1) == value.charAt(0);
            table.set(
                    line.substring(0, equals).trim(),
                    EnvLayer.coerce(quoted ? value.substring(1, value.length() - 1) : value, quoted));
        }
        return root;
    }

    /**
     * A {@code .env} file, mapped by SPEC section 4.6.
     *
     * <p>{@code Dotenv.Filter.DECLARED_IN_ENV_FILE} is load-bearing: without it dotenv-java hands
     * back the whole system environment merged with the file, and a shell variable silently
     * becomes configuration.
     *
     * <p>The quote scan is the second half. dotenv-java - like every {@code .env} reader in every
     * ecosystem - strips surrounding quotes and cannot tell you it did, and section 4.6 gives
     * quoting meaning: {@code PORT=5432} is the number, {@code PORT="5432"} is the string.
     */
    public static ObjectNode parseDotenv(Path path, String envPrefix) {
        String text = read(path);
        Set<String> quoted = new HashSet<>();
        for (String rawLine : text.split("\r?\n", -1)) {
            String line = rawLine.trim();
            if (line.startsWith("export ")) {
                line = line.substring("export ".length()).trim();
            }
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            int equals = line.indexOf('=');
            if (equals < 1) {
                continue;
            }
            String value = line.substring(equals + 1).trim();
            if (value.length() >= 2
                    && (value.charAt(0) == '"' || value.charAt(0) == '\'')
                    && value.charAt(value.length() - 1) == value.charAt(0)) {
                quoted.add(line.substring(0, equals).trim());
            }
        }

        Dotenv dotenv = Dotenv.configure()
                .directory(path.getParent().toString())
                .filename(path.getFileName().toString())
                .ignoreIfMissing()
                .ignoreIfMalformed()
                .load();

        ObjectNode out = JsonNodeFactory.instance.objectNode();
        String marker = envPrefix + "_";
        dotenv.entries(Dotenv.Filter.DECLARED_IN_ENV_FILE).stream()
                .sorted(java.util.Comparator.comparing(entry -> entry.getKey()))
                .forEach(entry -> {
                    String name = entry.getKey();
                    // The prefix is stripped when present and simply absent otherwise: a .env
                    // inside .config/<packageName>/ already says which package it belongs to.
                    String bare = name.toUpperCase(Locale.ROOT).startsWith(marker)
                            ? name.substring(marker.length())
                            : name;
                    List<String> keyPath = EnvLayer.keyPath(bare);
                    if (keyPath.isEmpty()) {
                        return;
                    }
                    EnvLayer.assign(out, keyPath, EnvLayer.coerce(entry.getValue(), quoted.contains(name)));
                });
        return out;
    }
}
