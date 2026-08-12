package dev.configdiscovery;

import static dev.configdiscovery.TestTrees.tree;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class LoadersTest {

    private static final String[] ONE_OF_EVERYTHING = {
        "c/config.toml", "from_toml = true\nlogLevel = \"debug\"\n[Nested]\nCamelKey = 1\n",
        "c/config.yaml", "from_yaml: true\n",
        "c/config.json", "{\"from_json\": true}\n",
        "c/config.jsonc", "// a comment\n{\"from_jsonc\": true /* inline */}\n",
        "c/config.ini", "[Section]\nport = 5432\nname = local\n",
        "c/.env", "FROM__DOTENV=true\nPORT=\"5432\"\n",
    };

    @Test
    void recognizedFilesComeBackInSpecOrder(@TempDir Path temp) {
        Path root = tree(temp, ONE_OF_EVERYTHING);
        List<String> names = new ArrayList<>();
        for (Loaders.FileRef file : Loaders.listConfigFiles(root.resolve("c"), null)) {
            names.add(file.path().getFileName().toString());
        }
        assertEquals(
                List.of("config.toml", "config.yaml", "config.json", "config.jsonc", "config.ini", ".env"), names);
    }

    @Test
    void everyRecognizedNameLoadsWithCaseIntact(@TempDir Path temp) {
        Path root = tree(temp, ONE_OF_EVERYTHING);
        ObjectNode merged = com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode();
        for (Loaders.FileRef file : Loaders.listConfigFiles(root.resolve("c"), null)) {
            merged.setAll(Loaders.loadOne(file, "MYTOOL"));
        }

        assertTrue(merged.get("from_toml").asBoolean());
        // Case survives: this is the assertion every language in this repository needs.
        assertEquals("debug", merged.get("logLevel").asText());
        assertEquals(1, merged.get("Nested").get("CamelKey").asInt());
        assertTrue(merged.get("from_yaml").asBoolean());
        assertTrue(merged.get("from_json").asBoolean());
        // JSONC through Jackson's ALLOW_JAVA_COMMENTS - no hand-rolled stripper.
        assertTrue(merged.get("from_jsonc").asBoolean());
        // INI arrives untyped, so SPEC section 2.5's coercion applies, and the section keeps case.
        assertEquals(5432, merged.get("Section").get("port").asInt());
        assertTrue(merged.get("Section").get("port").isIntegralNumber());
        assertTrue(merged.get("from").get("dotenv").asBoolean());
        // SPEC section 4.6: a value written inside quotes stays a string.
        assertTrue(merged.get("port").isTextual());
        assertEquals("5432", merged.get("port").asText());
    }

    @Test
    void theAmbientEnvironmentDoesNotLeakIntoADotenvLoad(@TempDir Path temp) {
        // dotenv-java merges System.getenv() into its result by default. PATH is set in every
        // JVM, so if the filter were missing it would appear here - and every fixture would break
        // in a way that depended on the developer's shell.
        Path root = tree(temp, "c/.env", "DECLARED=1\n");
        ObjectNode loaded = Loaders.loadOne(new Loaders.FileRef(root.resolve("c/.env"), "dotenv"), "MYTOOL");
        assertEquals(1, loaded.size());
        assertNull(loaded.get("path"));
        assertEquals(1, loaded.get("declared").asInt());
    }

    @Test
    void yamlBesideYmlIsADuplicateFormatError(@TempDir Path temp) {
        Path root = tree(temp, "c/config.yaml", "a: 1\n", "c/config.yml", "a: 2\n");
        ConfigException failure =
                assertThrows(ConfigException.class, () -> Loaders.listConfigFiles(root.resolve("c"), null));
        assertEquals(ConfigException.Kind.DUPLICATE_FORMAT, failure.kind());
    }

    @Test
    void aProfileFileFollowsItsBaseFile(@TempDir Path temp) {
        Path root = tree(temp, "c/config.toml", "a = 1\n", "c/config.prod.toml", "a = 2\n");
        List<Loaders.FileRef> files = Loaders.listConfigFiles(root.resolve("c"), "prod");
        assertEquals(2, files.size());
        assertEquals("config.prod.toml", files.get(1).path().getFileName().toString());
    }

    @Test
    void malformedTomlCarriesKindPathAndLine(@TempDir Path temp) {
        Path root = tree(temp, "c/config.toml", "[log\nlevel = \n");
        Path path = root.resolve("c/config.toml");
        ConfigException failure = assertThrows(
                ConfigException.class, () -> Loaders.loadOne(new Loaders.FileRef(path, "toml"), "MYTOOL"));
        assertEquals(ConfigException.Kind.MALFORMED, failure.kind());
        assertEquals(path.toString(), failure.path());
        assertTrue(failure.line() > 0, "expected a line number, got " + failure.line());
    }

    @Test
    void aReadFailureIsUnreadableNotMalformed(@TempDir Path temp) {
        // A directory where a file is expected. chmod 000 is not a portable way to express this:
        // an inherited ACL or a privileged user makes it a no-op.
        Path root = tree(temp, "c/config.toml/", "");
        ConfigException failure = assertThrows(
                ConfigException.class,
                () -> Loaders.loadOne(new Loaders.FileRef(root.resolve("c/config.toml"), "toml"), "MYTOOL"));
        assertEquals(ConfigException.Kind.UNREADABLE, failure.kind());
    }

    @Test
    void anEmptyFileIsReadAndEmpty(@TempDir Path temp) {
        Path root = tree(temp, "c/config.toml", "\n# nothing but a comment\n");
        assertTrue(Loaders.loadOne(new Loaders.FileRef(root.resolve("c/config.toml"), "toml"), "MYTOOL").isEmpty());
    }
}
