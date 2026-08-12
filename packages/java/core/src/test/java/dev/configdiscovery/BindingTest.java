package dev.configdiscovery;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.validation.constraints.Max;
import java.util.List;
import org.junit.jupiter.api.Test;

class BindingTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    record Settings(String logLevel, int port) {}

    static final class Constrained {
        @Max(1024)
        public int port;
    }

    private static ObjectNode config(String json) {
        try {
            return (ObjectNode) MAPPER.readTree(json);
        } catch (Exception cause) {
            throw new AssertionError(cause);
        }
    }

    @Test
    void bindsIntoARecord() {
        Settings settings = Binding.as(
                config("{\"logLevel\": \"debug\", \"port\": 5432}"), Settings.class, LoadOptions.standard());
        assertEquals("debug", settings.logLevel());
        assertEquals(5432, settings.port());
    }

    @Test
    void unknownKeysAreIgnoredByDefault() {
        Settings settings = Binding.as(
                config("{\"port\": 1, \"mystery\": true}"), Settings.class, LoadOptions.standard());
        assertEquals(1, settings.port());
    }

    @Test
    void strictModeSurfacesAnUnknownKey() {
        ConfigException failure = assertThrows(
                ConfigException.class,
                () -> Binding.as(
                        config("{\"port\": 1, \"mystery\": true}"),
                        Settings.class,
                        LoadOptions.builder().strict(true).build()));
        assertEquals(ConfigException.Kind.UNKNOWN_KEY, failure.kind());
        assertEquals("mystery", failure.keyPath());
    }

    @Test
    void aTypeMismatchIsValidationRatherThanASilentCoercion() {
        // The spec already coerced at load time. Coercing again here would repair the data and
        // hide the bug, so binding refuses instead.
        ConfigException failure = assertThrows(
                ConfigException.class,
                () -> Binding.as(config("{\"port\": \"not a number\"}"), Settings.class, LoadOptions.standard()));
        assertEquals(ConfigException.Kind.VALIDATION, failure.kind());
    }

    @Test
    void jakartaConstraintsAreEnforcedWhenAValidatorIsOnTheClasspath() {
        // hibernate-validator is a testRuntimeOnly dependency, so this exercises the reflective
        // path. With no validator present the same call simply binds and returns - which is what
        // keeps jakarta.validation-api compileOnly for consumers.
        ConfigException failure = assertThrows(
                ConfigException.class,
                () -> Binding.as(config("{\"port\": 5432}"), Constrained.class, LoadOptions.standard()));
        assertEquals(ConfigException.Kind.VALIDATION, failure.kind());
        assertEquals("port", failure.keyPath());
    }

    @Test
    void aValidObjectPassesValidation() {
        Constrained bound = Binding.as(config("{\"port\": 8}"), Constrained.class, LoadOptions.standard());
        assertEquals(8, bound.port);
    }

    @Test
    void everyKindHasAWireName() {
        assertEquals(
                List.of("not-found", "unreadable", "malformed", "duplicate-format", "unknown-key", "validation"),
                java.util.Arrays.stream(ConfigException.Kind.values())
                        .map(ConfigException.Kind::wireName)
                        .toList());
        assertTrue(ConfigException.of(ConfigException.Kind.MALFORMED, "/x", "boom", null)
                .getMessage()
                .contains("/x"));
    }
}
