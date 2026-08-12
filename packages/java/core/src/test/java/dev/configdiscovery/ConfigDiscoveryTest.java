package dev.configdiscovery;

import static dev.configdiscovery.TestTrees.tree;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ConfigDiscoveryTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static LoadOptions.Builder options(Path root) {
        return LoadOptions.builder()
                .cwd(root.resolve("project"))
                .home(root.resolve("home"))
                .env(Map.of())
                .warningHandler(message -> {});
    }

    @Test
    void localOnly(@TempDir Path temp) {
        Path root = tree(
                temp,
                "project/.git", "",
                "project/.config/mytool/config.toml", "[log]\nlevel = \"debug\"\n",
                "home/", "");
        Loaded loaded = ConfigDiscovery.load("mytool", options(root).build());
        assertEquals("debug", loaded.config().get("log").get("level").asText());
        assertTrue(loaded.found());
        assertEquals(1, loaded.sources().size());
        assertEquals(2, loaded.sources().get(0).precedence());
    }

    @Test
    void userOnly(@TempDir Path temp) {
        Path root = tree(temp, "project/.git", "", "home/.config/mytool/config.toml", "[log]\nlevel = \"info\"\n");
        Loaded loaded = ConfigDiscovery.load("mytool", options(root).build());
        assertEquals(1, loaded.sources().get(0).precedence());
    }

    @Test
    void neitherPresentIsNotAnError(@TempDir Path temp) {
        Path root = tree(temp, "project/.git", "", "home/", "");
        Loaded loaded = ConfigDiscovery.load("mytool", options(root).build());
        assertFalse(loaded.found());
        assertTrue(loaded.config().isEmpty());
        assertTrue(loaded.sources().isEmpty());
    }

    @Test
    void defaultsSurviveButDoNotSetFound(@TempDir Path temp) {
        Path root = tree(temp, "project/.git", "", "home/", "");
        ObjectNode defaults = MAPPER.createObjectNode();
        defaults.putObject("log").put("level", "warn");
        Loaded loaded = ConfigDiscovery.load("mytool", options(root).defaults(defaults).build());
        assertEquals("warn", loaded.config().get("log").get("level").asText());
        assertFalse(loaded.found());
        assertEquals("defaults", loaded.sources().get(0).format());
    }

    @Test
    void threeLayersConflictAndTheLosersAreStillReported(@TempDir Path temp) {
        Path root = tree(
                temp,
                "project/.git", "",
                "project/.config/mytool/config.toml", "[log]\nlevel = \"debug\"\n",
                "home/.config/mytool/config.toml", "[log]\nlevel = \"info\"\n");
        Loaded loaded = ConfigDiscovery.load(
                "mytool",
                options(root)
                        .env(Map.of("MYTOOL_LOG__LEVEL", "trace", "MYTOOL_PORT", "5432"))
                        .build());
        assertEquals("trace", loaded.config().get("log").get("level").asText());
        assertEquals(5432, loaded.config().get("port").asInt());
        assertEquals(List.of(1, 2, 4), loaded.sources().stream().map(Source::precedence).toList());
    }

    @Test
    void overridesWinOverEverything(@TempDir Path temp) {
        Path root = tree(
                temp,
                "project/.git", "",
                "project/.config/mytool/config.toml", "[log]\nlevel = \"debug\"\n",
                "home/", "");
        ObjectNode overrides = MAPPER.createObjectNode();
        overrides.putObject("log").put("level", "silent");
        Loaded loaded = ConfigDiscovery.load(
                "mytool",
                options(root)
                        .env(Map.of("MYTOOL_LOG__LEVEL", "trace"))
                        .overrides(overrides)
                        .build());
        assertEquals("silent", loaded.config().get("log").get("level").asText());
        assertEquals(5, loaded.sources().get(loaded.sources().size() - 1).precedence());
    }

    @Test
    void aPackageNameWithASeparatorIsRejected() {
        assertThrows(IllegalArgumentException.class, () -> ConfigDiscovery.load("../evil"));
    }

    @Test
    void everyErrorKindIsReachable(@TempDir Path temp) {
        Path malformed = tree(
                temp.resolve("a"), "project/.git", "", "project/.config/mytool/config.toml", "[log\n", "home/", "");
        assertEquals(
                ConfigException.Kind.MALFORMED,
                assertThrows(ConfigException.class, () -> ConfigDiscovery.load("mytool", options(malformed).build()))
                        .kind());

        Path duplicate = tree(
                temp.resolve("b"),
                "project/.git", "",
                "project/.config/mytool/config.yaml", "a: 1\n",
                "project/.config/mytool/config.yml", "a: 2\n",
                "home/", "");
        assertEquals(
                ConfigException.Kind.DUPLICATE_FORMAT,
                assertThrows(ConfigException.class, () -> ConfigDiscovery.load("mytool", options(duplicate).build()))
                        .kind());

        Path unreadable = tree(
                temp.resolve("c"), "project/.git", "", "project/.config/mytool/config.toml/", "", "home/", "");
        assertEquals(
                ConfigException.Kind.UNREADABLE,
                assertThrows(ConfigException.class, () -> ConfigDiscovery.load("mytool", options(unreadable).build()))
                        .kind());

        // NOT_FOUND exists so a caller can name the condition (SPEC section 5), not so it can be
        // thrown: an empty tree is a success.
        Path empty = tree(temp.resolve("d"), "project/.git", "", "home/", "");
        assertFalse(ConfigDiscovery.load("mytool", options(empty).build()).found());
        assertEquals("not-found", ConfigException.Kind.NOT_FOUND.wireName());
        // UNKNOWN_KEY and VALIDATION are reachable through binding; see BindingTest.
    }
}
