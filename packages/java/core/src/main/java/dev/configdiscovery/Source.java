package dev.configdiscovery;

import java.util.List;

/**
 * One contributing input - SPEC section 7.
 *
 * <p>Every source that was read appears in a {@link Loaded}, winner or loser. Without that, a
 * user seeing an unexpected value has no way to find which of six layers produced it.
 *
 * @param path absolute at runtime, rewritten by {@code relativeTo}; the literal
 *     {@code <defaults>}, {@code <env>} or {@code <overrides>} for the layers that are not files
 * @param format one of toml, yaml, json, jsonc, ini, dotenv, env, defaults, overrides
 * @param precedence the layer number from the SPEC section 3.1 table
 * @param keys the top-level keys this source contributed, sorted; empty for a file that parsed
 *     empty
 */
public record Source(String path, String format, int precedence, List<String> keys) {

    /** Canonicalizes {@code keys} to an immutable list so a {@code Source} is safe to share. */
    public Source {
        keys = keys == null ? List.of() : List.copyOf(keys);
    }
}
