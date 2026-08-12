package dev.configdiscovery;

import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * Load a program's configuration from {@code ./.config/<packageName>/}, walking up from the
 * working directory, with a fallback to {@code ~/.config/<packageName>/}, layered so
 * project-local values win.
 *
 * <p>Behavior is defined by {@code packages/spec/SPEC.md}, the contract five language
 * implementations share. This module has no Spring on its classpath; the optional Spring Boot
 * adapter lives in the sibling {@code spring} module.
 *
 * <pre>{@code
 * Loaded loaded = ConfigDiscovery.load("mytool");
 * if (!loaded.found()) {
 *     System.err.println("no config file found; using defaults");
 * }
 * MySettings settings = loaded.as(MySettings.class);
 * }</pre>
 */
public final class ConfigDiscovery {

    private ConfigDiscovery() {}

    /** Load with the ambient defaults. */
    public static Loaded load(String packageName) {
        return load(packageName, LoadOptions.standard());
    }

    /**
     * Load {@code packageName}'s configuration.
     *
     * <p>Finding nothing is not an error: the result is the defaults with {@code found = false}
     * and an empty {@code sources}. Finding something broken <strong>is</strong> an error - a
     * {@link ConfigException} naming the path - because silently falling back to defaults when a
     * YAML file has a tab in it is how a typo becomes an incident.
     */
    public static Loaded load(String packageName, LoadOptions options) {
        if (packageName == null
                || packageName.isBlank()
                || packageName.contains("/")
                || packageName.contains("\\")
                || packageName.equals(".")
                || packageName.equals("..")) {
            // A programming error, not a configuration one: it has no SPEC section 5 kind, and
            // dressing it up as a ConfigException would put it in the same catch as a broken file.
            throw new IllegalArgumentException("package name \"" + packageName + "\" must be a single path segment");
        }

        String prefix = options.envPrefix() != null
                ? options.envPrefix().toUpperCase(Locale.ROOT)
                : packageName.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "_");

        Optional<Path> userRoot = Discovery.resolveUserRoot(
                packageName, options.home(), options.env(), options.warningHandler());
        List<Path> projectRoots = Discovery.resolveProjectRoots(
                options.cwd(), packageName, new Discovery.WalkOptions(options.home(), options.stopDir()));

        record Block(Path root, int precedence) {}
        List<Block> blocks = new ArrayList<>();
        userRoot.ifPresent(root -> blocks.add(new Block(root, 1)));
        projectRoots.forEach(root -> blocks.add(new Block(root, 2)));

        List<Merge.Layer> layers = new ArrayList<>();
        if (!options.defaults().isEmpty()) {
            layers.add(new Merge.Layer(
                    options.defaults(), new Source("<defaults>", "defaults", 0, List.of()), null));
        }

        for (Block block : blocks) {
            for (Loaders.FileRef file : Loaders.listConfigFiles(block.root(), options.profile())) {
                ObjectNode value = Loaders.loadOne(file, prefix);
                // SPEC section 3.1: a .env is its own layer, applied inside its root's block.
                int precedence = "dotenv".equals(file.format()) ? 3 : block.precedence();
                layers.add(new Merge.Layer(
                        value,
                        new Source(file.path().toString(), file.format(), precedence, List.of()),
                        block.root().toString()));
            }
        }

        ObjectNode fromEnv = EnvLayer.build(options.env(), prefix, options.warningHandler());
        if (!fromEnv.isEmpty()) {
            layers.add(new Merge.Layer(fromEnv, new Source("<env>", "env", 4, List.of()), null));
        }
        if (!options.overrides().isEmpty()) {
            layers.add(new Merge.Layer(
                    options.overrides(), new Source("<overrides>", "overrides", 5, List.of()), null));
        }

        List<Merge.Layer> contributing = Merge.applyStrategy(layers, options.strategy());
        ObjectNode merged = Merge.mergeLayers(
                contributing, new Merge.MergeOptions(options.arrayMerge(), options.warningHandler()));

        boolean found = contributing.stream().anyMatch(layer -> layer.root() != null);
        return new Loaded(merged, found, Sources.build(contributing, options.relativeTo()));
    }
}
