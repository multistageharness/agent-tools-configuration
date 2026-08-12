package dev.configdiscovery;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * The environment-variable layer - SPEC section 4.5 - and the name mapping {@code .env} files
 * share with it (SPEC section 4.6).
 *
 * <p>The coercion rule is parse-as-JSON-or-keep-the-string, chosen because JSON is the one grammar
 * all five ecosystems already have. {@code MYTOOL_PORT=5432} is the <em>number</em> 5432, and it
 * lands in an {@code IntNode} rather than a {@code DoubleNode} so it serializes as {@code 5432}
 * and not {@code 5432.0} - the conformance probe depends on that.
 */
public final class EnvLayer {

    private static final com.fasterxml.jackson.databind.ObjectReader READER = new ObjectMapper()
            .enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .readerFor(JsonNode.class);

    private EnvLayer() {}

    /**
     * Map a variable name, prefix already stripped, to a key path: lowercase, split on {@code __},
     * and leave a single {@code _} alone. {@code SOME_KEY} is the single key {@code some_key}, not
     * {@code some.key}.
     */
    public static List<String> keyPath(String name) {
        List<String> path = new ArrayList<>();
        for (String segment : name.toLowerCase(java.util.Locale.ROOT).split("__", -1)) {
            if (!segment.isEmpty()) {
                path.add(segment);
            }
        }
        return path;
    }

    /**
     * SPEC section 4.5 step 5. {@code wasQuoted} short-circuits it for {@code .env} values written
     * inside quotes, which section 4.6 keeps as strings.
     */
    public static JsonNode coerce(String raw, boolean wasQuoted) {
        if (wasQuoted) {
            return TextNode.valueOf(raw);
        }
        try {
            // FAIL_ON_TRAILING_TOKENS is what makes `5432abc` a string: without it Jackson reads
            // the leading 5432, stops, and reports the number - the exact wrong answer.
            JsonNode parsed = READER.readValue(raw);
            if (parsed == null || parsed.isMissingNode()) {
                return TextNode.valueOf(raw);
            }
            return normalizeNumbers(parsed);
        } catch (java.io.IOException notJson) {
            return TextNode.valueOf(raw);
        }
    }

    /**
     * Whole numbers become {@code IntNode}/{@code LongNode} rather than {@code DoubleNode}, so a
     * 5432 from an environment variable is the same node type as a 5432 from a TOML file.
     */
    static JsonNode normalizeNumbers(JsonNode node) {
        if (node.isObject()) {
            ObjectNode out = JsonNodeFactory.instance.objectNode();
            node.fields().forEachRemaining(entry -> out.set(entry.getKey(), normalizeNumbers(entry.getValue())));
            return out;
        }
        if (node.isArray()) {
            var out = JsonNodeFactory.instance.arrayNode(node.size());
            node.forEach(item -> out.add(normalizeNumbers(item)));
            return out;
        }
        if (node.isFloatingPointNumber()) {
            double value = node.doubleValue();
            if (value == Math.rint(value) && Math.abs(value) < 9.007199254740992E15) {
                return JsonNodeFactory.instance.numberNode((long) value);
            }
        }
        return node;
    }

    /**
     * Layer 4.
     *
     * <p>{@code env} is a parameter and is never {@code System.getenv()} in here: the probe and
     * every test depend on an exported {@code MYTOOL_*} in the developer's shell being unable to
     * reach this method.
     */
    public static ObjectNode build(Map<String, String> env, String prefix, Consumer<String> warn) {
        ObjectNode out = JsonNodeFactory.instance.objectNode();
        String marker = prefix + "_";
        env.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .forEach(entry -> {
                    if (!entry.getKey().startsWith(marker)) {
                        return;
                    }
                    List<String> path = keyPath(entry.getKey().substring(marker.length()));
                    if (path.isEmpty()) {
                        warn.accept("ignoring " + entry.getKey() + ": it maps to an empty key path");
                        return;
                    }
                    assign(out, path, coerce(entry.getValue(), false));
                });
        return out;
    }

    /** Write {@code value} at {@code path}, creating objects along the way and replacing non-objects. */
    public static void assign(ObjectNode target, List<String> path, JsonNode value) {
        if (path.isEmpty()) {
            return;
        }
        ObjectNode node = target;
        for (String segment : path.subList(0, path.size() - 1)) {
            JsonNode existing = node.get(segment);
            if (existing == null || !existing.isObject()) {
                node = node.putObject(segment);
            } else {
                node = (ObjectNode) existing;
            }
        }
        node.set(path.get(path.size() - 1), value);
    }
}
