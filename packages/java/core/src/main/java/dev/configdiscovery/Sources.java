package dev.configdiscovery;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * The {@code sources} output - SPEC section 7.
 *
 * <p>The only thing standing between a user who expected {@code debug} and an afternoon of
 * guessing which of six layers set {@code trace}, so every source that was read is listed,
 * winners and losers alike.
 */
public final class Sources {

    private Sources() {}

    /**
     * Emit entries in <strong>application order</strong> - the order the layers were merged,
     * lowest effective priority first (SPEC section 3.1).
     *
     * <p>That is ascending precedence with one documented exception: a root's {@code .env}
     * (precedence 3) belongs inside that root's block, so a user-level {@code .env} still loses to
     * a project-local {@code config.toml}. Sorting this list by precedence would reorder it into
     * something that does not describe what happened.
     */
    public static List<Source> build(List<Merge.Layer> layers, Path relativeTo) {
        List<Source> sources = new ArrayList<>(layers.size());
        for (Merge.Layer layer : layers) {
            List<String> keys = new ArrayList<>();
            layer.value().fieldNames().forEachRemaining(keys::add);
            keys.sort(String::compareTo);
            sources.add(new Source(
                    rewrite(layer.source().path(), relativeTo),
                    layer.source().format(),
                    layer.source().precedence(),
                    keys));
        }
        return List.copyOf(sources);
    }

    static String rewrite(String path, Path relativeTo) {
        // <defaults>, <env> and <overrides> are labels, not paths, and are passed through.
        Path candidate = Path.of(path);
        if (relativeTo == null || !candidate.isAbsolute()) {
            return path;
        }
        if (!candidate.startsWith(relativeTo)) {
            // Outside the fixture root: stay absolute rather than emit a ../../ climb that no
            // expected.json could match.
            return slash(candidate);
        }
        return slash(relativeTo.relativize(candidate));
    }

    private static String slash(Path path) {
        // Forward slashes on every platform - on Windows this is not a no-op.
        StringBuilder text = new StringBuilder();
        for (Path segment : path) {
            if (text.length() > 0) {
                text.append('/');
            }
            text.append(segment);
        }
        String result = text.toString();
        return path.isAbsolute() ? "/" + result : result;
    }
}
