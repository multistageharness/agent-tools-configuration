package dev.configdiscovery;

import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Path;
import java.util.Map;
import java.util.function.Consumer;

/**
 * Everything {@link ConfigDiscovery#load} can be told - SPEC section 6.
 *
 * <p>Every ambient input - the working directory, the home directory, the environment - has a
 * builder method that replaces it, which is what makes the conformance probe and every test in
 * this module hermetic.
 */
public record LoadOptions(
        Merge.Strategy strategy,
        Merge.ArrayMerge arrayMerge,
        Path stopDir,
        String envPrefix,
        String profile,
        boolean strict,
        Path home,
        Path cwd,
        Map<String, String> env,
        ObjectNode defaults,
        ObjectNode overrides,
        Path relativeTo,
        Consumer<String> warningHandler) {

    /**
     * Options with every ambient default resolved from the process.
     *
     * <p>Named {@code standard} rather than {@code defaults} because {@code defaults()} is
     * already the record accessor for layer 0.
     */
    public static LoadOptions standard() {
        return builder().build();
    }

    /** A fresh builder. */
    public static Builder builder() {
        return new Builder();
    }

    /** Builds {@link LoadOptions}. */
    public static final class Builder {
        private Merge.Strategy strategy = Merge.Strategy.LAYERED;
        private Merge.ArrayMerge arrayMerge = Merge.ArrayMerge.REPLACE;
        private Path stopDir;
        private String envPrefix;
        private String profile;
        private boolean strict;
        private Path home;
        private Path cwd;
        private Map<String, String> env;
        private ObjectNode defaults = JsonNodeFactory.instance.objectNode();
        private ObjectNode overrides = JsonNodeFactory.instance.objectNode();
        private Path relativeTo;
        private Consumer<String> warningHandler = message -> System.err.println("warning: " + message);

        private Builder() {}

        /** Whether every root contributes or only the nearest one with a file. */
        public Builder strategy(Merge.Strategy value) {
            this.strategy = value;
            return this;
        }

        /** How arrays combine. */
        public Builder arrayMerge(Merge.ArrayMerge value) {
            this.arrayMerge = value;
            return this;
        }

        /** An extra, inclusive stop condition for the upward walk. */
        public Builder stopDir(Path value) {
            this.stopDir = value;
            return this;
        }

        /** Override the prefix for the environment layer. */
        public Builder envPrefix(String value) {
            this.envPrefix = value;
            return this;
        }

        /** Also load {@code config.<profile>.<ext>} beside each base file. */
        public Builder profile(String value) {
            this.profile = value;
            return this;
        }

        /** Promote an unknown key from a warning to an error when binding. */
        public Builder strict(boolean value) {
            this.strict = value;
            return this;
        }

        /** Override the home directory the user-level root resolves under. */
        public Builder home(Path value) {
            this.home = value;
            return this;
        }

        /** Override the directory the upward walk starts from. */
        public Builder cwd(Path value) {
            this.cwd = value;
            return this;
        }

        /** Replace the environment the prefixed layer reads. */
        public Builder env(Map<String, String> value) {
            this.env = value;
            return this;
        }

        /** Layer 0. */
        public Builder defaults(ObjectNode value) {
            this.defaults = value;
            return this;
        }

        /** Layer 5. */
        public Builder overrides(ObjectNode value) {
            this.overrides = value;
            return this;
        }

        /** Emit {@link Source#path()} relative to this directory. Used by the conformance probe. */
        public Builder relativeTo(Path value) {
            this.relativeTo = value;
            return this;
        }

        /** Route diagnostics. The default writes to standard error. */
        public Builder warningHandler(Consumer<String> value) {
            this.warningHandler = value;
            return this;
        }

        /**
         * Finish, resolving any ambient input the caller did not supply.
         *
         * <p>These four lines are the only places this library reads the process, and each is
         * overridable above.
         */
        public LoadOptions build() {
            Path resolvedCwd = cwd != null ? cwd : Path.of(System.getProperty("user.dir"));
            Path resolvedHome = home != null ? home : Path.of(System.getProperty("user.home"));
            Map<String, String> resolvedEnv = env != null ? Map.copyOf(env) : Map.copyOf(System.getenv());
            return new LoadOptions(
                    strategy,
                    arrayMerge,
                    stopDir,
                    envPrefix,
                    profile,
                    strict,
                    resolvedHome,
                    resolvedCwd,
                    resolvedEnv,
                    defaults,
                    overrides,
                    relativeTo,
                    warningHandler);
        }
    }
}
