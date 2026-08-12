package dev.configdiscovery;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * Merge semantics - SPEC section 4, expressed over {@link JsonNode}.
 *
 * <p>{@code NullNode} being a distinct type from absence makes the explicit-null-unsets rule of
 * section 4.4 nearly free here, where Python and Go both need a sentinel: presence is
 * {@code has(key)} and an explicit null is {@code isNull()}, two different questions.
 */
public final class Merge {

    private Merge() {}

    /** One layer on its way into the merge, with the source it will be reported as. */
    public record Layer(ObjectNode value, Source source, String root) {}

    /** How arrays combine (SPEC section 4.3). */
    public enum ArrayMerge {
        /** The higher layer's array is the result. The default. */
        REPLACE,
        /** Append the higher layer's elements onto the lower layer's, with no deduplication. */
        CONCAT
    }

    /** Which roots contribute (SPEC section 3.2). */
    public enum Strategy {
        /** Every resolved root contributes. The default. */
        LAYERED,
        /** Only the highest-precedence root that contained a recognized file contributes. */
        FIRST_MATCH
    }

    /** Merge inputs that are not the layers themselves. */
    public record MergeOptions(ArrayMerge arrayMerge, Consumer<String> warn) {}

    /** Fold the layers lowest precedence first. */
    public static ObjectNode mergeLayers(List<Layer> layers, MergeOptions opts) {
        ObjectNode result = JsonNodeFactory.instance.objectNode();
        for (Layer layer : layers) {
            // deepCopy so no input node is aliased into the result and mutated by a later layer,
            // or by the caller afterwards.
            mergeInto(result, layer.value().deepCopy(), opts, "");
        }
        return result;
    }

    private static void mergeInto(ObjectNode lower, ObjectNode higher, MergeOptions opts, String path) {
        higher.fieldNames().forEachRemaining(key -> {
            JsonNode value = higher.get(key);
            String at = path.isEmpty() ? key : path + "." + key;

            // SPEC section 4.4. Absent is not null: a key the higher layer never mentions is not
            // in this iteration at all, and a key set to null asks for a delete.
            if (value.isNull()) {
                lower.remove(key);
                return;
            }

            JsonNode existing = lower.has(key) ? lower.get(key) : null;
            if (existing != null && existing.isObject() && value.isObject()) {
                mergeInto((ObjectNode) existing, (ObjectNode) value, opts, at);
                return;
            }
            if (existing != null && existing.isArray() && value.isArray()) {
                // SPEC section 4.3: replace by default; concat appends and never deduplicates.
                if (opts.arrayMerge() == ArrayMerge.CONCAT) {
                    ((ArrayNode) existing).addAll((ArrayNode) value);
                } else {
                    lower.set(key, value);
                }
                return;
            }
            if (existing != null && existing.isObject() != value.isObject() && opts.warn() != null) {
                opts.warn().accept(at + ": replacing " + (existing.isObject() ? "a map" : "a scalar")
                        + " with " + (value.isObject() ? "a map" : "a scalar") + " (SPEC section 4.2)");
            }
            lower.set(key, value);
        });
    }

    /**
     * SPEC section 3.2.
     *
     * <p>Under {@link Strategy#FIRST_MATCH} only the highest-precedence root that contributed a
     * file survives - the lower roots are dropped from the merge <em>and</em> from
     * {@code sources}, because the option means "the others were never consulted", not "the
     * others lost". The rootless layers - defaults, env, overrides - always survive: the option
     * scopes the file layers only.
     */
    public static List<Layer> applyStrategy(List<Layer> layers, Strategy strategy) {
        if (strategy != Strategy.FIRST_MATCH) {
            return layers;
        }
        String winning = null;
        for (Layer layer : layers) {
            if (layer.root() != null) {
                winning = layer.root();
            }
        }
        List<Layer> kept = new ArrayList<>();
        for (Layer layer : layers) {
            if (layer.root() == null || layer.root().equals(winning)) {
                kept.add(layer);
            }
        }
        return List.copyOf(kept);
    }
}
