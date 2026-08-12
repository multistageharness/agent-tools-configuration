package dev.configdiscovery;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Builds a synthetic tree under a {@code @TempDir}.
 *
 * <p>Every test in this module builds its own tree and injects {@code cwd} and {@code home}.
 * Nothing reads {@code user.dir} or {@code user.home}: those are process-global on the JVM and
 * cannot be varied per test, which is exactly why the options exist.
 */
final class TestTrees {

    private TestTrees() {}

    /** {@code path, contents, path, contents, …}; a path ending in {@code /} is a directory. */
    static Path tree(Path root, String... pathsAndContents) {
        try {
            for (int index = 0; index < pathsAndContents.length; index += 2) {
                String relative = pathsAndContents[index];
                Path target = root.resolve(relative);
                if (relative.endsWith("/")) {
                    Files.createDirectories(target);
                    continue;
                }
                Files.createDirectories(target.getParent());
                Files.writeString(target, pathsAndContents[index + 1]);
            }
            return root.toRealPath();
        } catch (IOException cause) {
            throw new UncheckedIOException(cause);
        }
    }
}
