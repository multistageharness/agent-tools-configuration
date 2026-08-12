package dev.configdiscovery;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Consumer;

/**
 * Search-path resolution - SPEC section 2.
 *
 * <p>Nothing in the Java ecosystem walks upward looking for a config directory, so the walk is
 * entirely ours - in every language. This class is the Java half of keeping those five
 * hand-written walks identical.
 */
public final class Discovery {

    /**
     * A pathological mount or an uncollapsed symlink loop should fail loudly rather than spin. No
     * real tree is 64 directories deep below its repository root.
     */
    static final int MAX_DEPTH = 64;

    private Discovery() {}

    /** Inputs to the walk that are not the working directory. */
    public record WalkOptions(Path home, Path stopDir) {

        /** No home, no stop directory. */
        public static WalkOptions none() {
            return new WalkOptions(null, null);
        }
    }

    /**
     * Every existing {@code .config/<packageName>/} from {@code cwd} upward, farthest ancestor
     * first - the SPEC section 2.7 order, so the nearest root is last and therefore wins.
     */
    public static List<Path> resolveProjectRoots(Path cwd, String packageName, WalkOptions opts) {
        // SPEC section 2.1: resolved exactly once. A failure is reported rather than papered over,
        // because silently walking an unresolved path searches the wrong ancestors.
        Path dir = realPath(cwd);
        Path home = opts.home() == null ? null : realPathOrRaw(opts.home());
        Path stopDir = opts.stopDir() == null ? null : realPathOrRaw(opts.stopDir());

        List<Path> roots = new ArrayList<>();
        for (int depth = 0; ; depth++) {
            if (depth > MAX_DEPTH) {
                throw ConfigException.of(
                        ConfigException.Kind.UNREADABLE,
                        cwd.toString(),
                        "upward walk exceeded " + MAX_DEPTH + " directories",
                        null);
            }

            // SPEC section 2.2: a directory is checked before it is tested for stopping, so a
            // config beside a .git is found and the walk then ends.
            Path candidate = dir.resolve(".config").resolve(packageName);
            if (Files.isDirectory(candidate)) {
                roots.add(candidate);
            }

            Path parent = dir.getParent();
            boolean atFilesystemRoot = parent == null;
            boolean atHome = home != null && dir.equals(home);
            boolean atStopDir = stopDir != null && dir.equals(stopDir);
            // Both forms count: a directory in a normal clone, a file in a worktree or a
            // submodule. Those are repositories too.
            boolean atRepositoryBoundary = Files.exists(dir.resolve(".git"));

            if (atFilesystemRoot || atHome || atStopDir || atRepositoryBoundary) {
                break;
            }
            dir = parent;
        }

        Collections.reverse(roots);
        return List.copyOf(roots);
    }

    private static Path realPath(Path path) {
        try {
            return path.toRealPath();
        } catch (IOException cause) {
            throw ConfigException.of(
                    ConfigException.Kind.UNREADABLE, path.toString(), cause.toString(), cause);
        }
    }

    /**
     * Resolve when the path exists, and fall back to the normalized path otherwise - so a stop
     * directory that has not been created yet still compares by name.
     */
    private static Path realPathOrRaw(Path path) {
        try {
            return path.toRealPath();
        } catch (IOException ignored) {
            return path.toAbsolutePath().normalize();
        }
    }

    /**
     * The single user-level root of SPEC section 2.4, or empty when there is none - so a caller
     * can tell "no user config at all" from "the user config directory is empty".
     *
     * <p>Windows takes this identical path. {@code %APPDATA%} and {@code %LOCALAPPDATA%} are
     * deliberately not consulted (SPEC section 2.4): the same directory has to be readable by five
     * language implementations, and one documented location beats a native one nobody can predict.
     *
     * <p>{@code home} is a parameter, never {@code System.getProperty("user.home")}, which is
     * process-global on the JVM and so cannot be varied per test.
     */
    public static Optional<Path> resolveUserRoot(
            String packageName, Path home, Map<String, String> env, Consumer<String> warn) {
        String xdg = env.get("XDG_CONFIG_HOME");
        Path root;
        if (xdg != null && !xdg.isBlank() && Path.of(xdg).isAbsolute()) {
            root = Path.of(xdg).resolve(packageName);
        } else {
            if (xdg != null) {
                warn.accept("ignoring XDG_CONFIG_HOME=\"" + xdg
                        + "\": it must be a non-blank absolute path (SPEC section 2.4)");
            }
            root = home.resolve(".config").resolve(packageName);
        }
        return Files.isDirectory(root) ? Optional.of(root) : Optional.empty();
    }
}
