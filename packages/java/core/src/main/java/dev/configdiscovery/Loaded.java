package dev.configdiscovery;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Map;

/**
 * The result of a successful load - SPEC section 7.
 *
 * @param config the merged configuration
 * @param found true when at least one recognized <em>file</em> contributed; defaults and
 *     environment variables do not set it
 * @param sources application order, lowest effective priority first
 */
public record Loaded(JsonNode config, boolean found, List<Source> sources) {

    /** Canonicalizes {@code sources} to an immutable list. */
    public Loaded {
        sources = sources == null ? List.of() : List.copyOf(sources);
    }

    /** Bind the merged configuration to {@code type}. See {@link Binding}. */
    public <T> T as(Class<T> type) {
        return Binding.as(config, type, LoadOptions.standard());
    }

    /** Bind the merged configuration to {@code type}, honoring {@code options.strict()}. */
    public <T> T as(Class<T> type, LoadOptions options) {
        return Binding.as(config, type, options);
    }

    /** The merged configuration as a plain map. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> asMap() {
        return Binding.MAPPER.convertValue(config, Map.class);
    }
}
