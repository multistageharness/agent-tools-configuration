package dev.configdiscovery;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class MergeTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private final List<String> warnings = new ArrayList<>();

    private static ObjectNode node(String json) {
        try {
            return (ObjectNode) MAPPER.readTree(json);
        } catch (JsonProcessingException cause) {
            throw new AssertionError(cause);
        }
    }

    private static Merge.Layer layer(String json, String root, int precedence) {
        String path = root == null ? "<env>" : root + "/config.toml";
        String format = root == null ? "env" : "toml";
        return new Merge.Layer(node(json), new Source(path, format, precedence, List.of()), root);
    }

    private ObjectNode merge(List<Merge.Layer> layers, Merge.ArrayMerge arrayMerge) {
        return Merge.mergeLayers(layers, new Merge.MergeOptions(arrayMerge, warnings::add));
    }

    // These mirror the conformance fixtures one to one, so a unit failure and a conformance
    // failure point at the same clause of SPEC.
    @Test
    void bothScalarConflict() {
        assertEquals(
                node("{\"log\": {\"level\": \"debug\"}}"),
                merge(
                        List.of(
                                layer("{\"log\": {\"level\": \"info\"}}", "/user", 1),
                                layer("{\"log\": {\"level\": \"debug\"}}", "/project", 2)),
                        Merge.ArrayMerge.REPLACE));
    }

    @Test
    void bothNestedMapMerge() {
        assertEquals(
                node("{\"database\": {\"host\": \"db.example.com\", \"port\": 6543}}"),
                merge(
                        List.of(
                                layer("{\"database\": {\"host\": \"db.example.com\", \"port\": 5432}}", "/user", 1),
                                layer("{\"database\": {\"port\": 6543}}", "/project", 2)),
                        Merge.ArrayMerge.REPLACE));
    }

    @Test
    void bothArrayReplace() {
        assertEquals(
                node("{\"plugins\": [\"c\"]}"),
                merge(
                        List.of(
                                layer("{\"plugins\": [\"a\", \"b\"]}", "/user", 1),
                                layer("{\"plugins\": [\"c\"]}", "/project", 2)),
                        Merge.ArrayMerge.REPLACE));
    }

    @Test
    void bothArrayConcatKeepsDuplicates() {
        assertEquals(
                node("{\"plugins\": [\"a\", \"b\", \"b\", \"c\"]}"),
                merge(
                        List.of(
                                layer("{\"plugins\": [\"a\", \"b\"]}", "/user", 1),
                                layer("{\"plugins\": [\"b\", \"c\"]}", "/project", 2)),
                        Merge.ArrayMerge.CONCAT));
    }

    @Test
    void explicitNullUnsetsWhileAbsentLeavesAlone() {
        assertEquals(
                node("{}"),
                merge(
                        List.of(layer("{\"a\": 1}", "/user", 1), layer("{\"a\": null}", "/project", 2)),
                        Merge.ArrayMerge.REPLACE));
        // NullNode is a type, not an absence: the distinction Python and Go both need a sentinel
        // for is free here, and this is the test that pins it.
        assertEquals(
                node("{\"a\": 1}"),
                merge(
                        List.of(layer("{\"a\": 1}", "/user", 1), layer("{}", "/project", 2)),
                        Merge.ArrayMerge.REPLACE));
    }

    @Test
    void aTypeConflictWarns() {
        assertEquals(
                node("{\"log\": \"debug\"}"),
                merge(
                        List.of(
                                layer("{\"log\": {\"level\": \"info\"}}", "/user", 1),
                                layer("{\"log\": \"debug\"}", "/project", 2)),
                        Merge.ArrayMerge.REPLACE));
        assertEquals(1, warnings.size());
        assertTrue(warnings.get(0).contains("replacing a map with a scalar"), warnings.get(0));
    }

    @Test
    void theResultDoesNotAliasTheInputLayers() {
        Merge.Layer input = layer("{\"log\": {\"level\": \"info\"}}", "/user", 1);
        ObjectNode result = merge(List.of(input), Merge.ArrayMerge.REPLACE);
        ((ObjectNode) result.get("log")).put("level", "mutated");
        assertEquals("info", input.value().get("log").get("level").asText());
    }

    @Test
    void firstMatchDropsTheLowerRootFromOutputAndSources() {
        List<Merge.Layer> layers = List.of(
                layer("{\"d\": 1}", null, 0),
                layer("{\"log\": {\"level\": \"info\"}}", "/user", 1),
                layer("{\"log\": {\"level\": \"debug\"}}", "/project", 2),
                layer("{\"log\": {\"level\": \"trace\"}}", null, 4));
        List<Merge.Layer> kept = Merge.applyStrategy(layers, Merge.Strategy.FIRST_MATCH);
        // The user layer is gone entirely - not merged, and not reported.
        assertEquals(3, kept.size());
        assertEquals("/project", kept.get(1).root());
        assertEquals(node("{\"d\": 1, \"log\": {\"level\": \"trace\"}}"), merge(kept, Merge.ArrayMerge.REPLACE));
    }

    @Test
    void envCoercion() {
        assertTrue(EnvLayer.coerce("5432", false).isIntegralNumber());
        assertEquals(5432, EnvLayer.coerce("5432", false).asInt());
        assertTrue(EnvLayer.coerce("true", false).isBoolean());
        assertTrue(EnvLayer.coerce("[1,2]", false).isArray());
        assertTrue(EnvLayer.coerce("5432abc", false).isTextual());
        assertTrue(EnvLayer.coerce("trace", false).isTextual());
        assertTrue(EnvLayer.coerce("5432", true).isTextual());
    }

    @Test
    void envMappingSplitsOnDoubleUnderscoreOnly() {
        ObjectNode built = EnvLayer.build(
                Map.of("MYTOOL_LOG__LEVEL", "trace", "MYTOOL_SOME_KEY", "1", "OTHER_X", "y"),
                "MYTOOL",
                warnings::add);
        assertEquals("trace", built.get("log").get("level").asText());
        assertEquals(1, built.get("some_key").asInt());
        assertFalse(built.has("x"));
    }

    @Test
    void aWholeNumberFromTheEnvironmentSerializesWithoutADecimalPoint() throws JsonProcessingException {
        ObjectNode built = EnvLayer.build(Map.of("MYTOOL_PORT", "5432"), "MYTOOL", warnings::add);
        assertEquals("{\"port\":5432}", MAPPER.writeValueAsString(built));
    }

    @Test
    void sourcesPreserveApplicationOrderRatherThanSortingByPrecedence() {
        // A user-level .env is precedence 3 but belongs inside the user root's block, so it must
        // still be emitted before the project files that outrank it (SPEC section 3.1).
        List<Source> sources = Sources.build(
                List.of(
                        layer("{}", "/u", 1),
                        new Merge.Layer(node("{}"), new Source("/u/.env", "dotenv", 3, List.of()), "/u"),
                        layer("{}", "/p", 2)),
                null);
        assertEquals(List.of(1, 3, 2), sources.stream().map(Source::precedence).toList());
        assertTrue(sources.get(0).keys().isEmpty());
    }
}
