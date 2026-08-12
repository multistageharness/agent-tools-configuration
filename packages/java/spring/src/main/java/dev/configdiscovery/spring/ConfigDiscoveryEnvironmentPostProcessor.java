package dev.configdiscovery.spring;

import com.fasterxml.jackson.databind.JsonNode;
import dev.configdiscovery.ConfigDiscovery;
import dev.configdiscovery.LoadOptions;
import dev.configdiscovery.Loaded;
import dev.configdiscovery.Source;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.MutablePropertySources;

/**
 * Exposes {@code .config/<packageName>/} discovery through Spring Boot's own property-source
 * mechanism, so {@code @ConfigurationProperties} and relaxed binding keep working.
 *
 * <h2>What this does and does not promise</h2>
 *
 * <p>Spring interleaves its own property sources - command line, system properties,
 * {@code application.yml}, and more - and a library cannot reorder them. This post-processor
 * reproduces the spec's <em>relative</em> order among the roots it contributes: project-local
 * outranks user-level, nearest ancestor outranks farthest. It does <strong>not</strong> reproduce
 * SPEC section 3 overall, and it deliberately does not try to outrank Spring's command-line or
 * system-property sources, which is Spring's convention and should not be fought.
 *
 * <p>{@code spring/README.md} lists the real resulting order, including Spring's own sources. A
 * user who reads a claim of parity here and later discovers otherwise is worse off than one who
 * was told the truth up front.
 */
public class ConfigDiscoveryEnvironmentPostProcessor implements EnvironmentPostProcessor {

    /** The package name to discover, when {@code spring.application.name} is not what you want. */
    public static final String PACKAGE_NAME_PROPERTY = "config-discovery.package-name";

    /** Property source name prefix, so the sources are identifiable in an actuator dump. */
    static final String SOURCE_PREFIX = "config-discovery:";

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        String packageName = environment.getProperty(PACKAGE_NAME_PROPERTY);
        if (packageName == null || packageName.isBlank()) {
            packageName = environment.getProperty("spring.application.name");
        }
        if (packageName == null || packageName.isBlank()) {
            return; // Nothing to discover, and guessing a name would be worse than doing nothing.
        }

        LoadOptions.Builder options = LoadOptions.builder();
        String cwd = environment.getProperty("config-discovery.cwd");
        if (cwd != null && !cwd.isBlank()) {
            options.cwd(Path.of(cwd));
        }
        String home = environment.getProperty("config-discovery.home");
        if (home != null && !home.isBlank()) {
            options.home(Path.of(home));
        }

        Loaded loaded = ConfigDiscovery.load(packageName, options.build());
        if (!loaded.found() && loaded.sources().isEmpty()) {
            return;
        }

        MutablePropertySources propertySources = environment.getPropertySources();
        // Added lowest-first with addFirst, so the last one added - the nearest project root -
        // ends up highest among this library's sources, while all of them sit below whatever
        // Spring already put in front.
        for (Source source : loaded.sources()) {
            Map<String, Object> flattened = new LinkedHashMap<>();
            flatten(loaded.config(), "", flattened, source.keys());
            if (flattened.isEmpty()) {
                continue;
            }
            propertySources.addLast(new MapPropertySource(SOURCE_PREFIX + source.path(), flattened));
        }
    }

    /**
     * Flatten the merged tree to Spring's dotted key form, restricted to the top-level keys a
     * given source contributed.
     */
    private static void flatten(JsonNode node, String prefix, Map<String, Object> out, List<String> onlyTopLevel) {
        node.fields().forEachRemaining(entry -> {
            if (prefix.isEmpty() && !onlyTopLevel.isEmpty() && !onlyTopLevel.contains(entry.getKey())) {
                return;
            }
            String key = prefix.isEmpty() ? entry.getKey() : prefix + "." + entry.getKey();
            JsonNode value = entry.getValue();
            if (value.isObject()) {
                flatten(value, key, out, List.of());
            } else if (value.isArray()) {
                for (int index = 0; index < value.size(); index++) {
                    out.put(key + "[" + index + "]", scalar(value.get(index)));
                }
            } else {
                out.put(key, scalar(value));
            }
        });
    }

    private static Object scalar(JsonNode value) {
        if (value.isNumber()) {
            return value.numberValue();
        }
        if (value.isBoolean()) {
            return value.booleanValue();
        }
        return value.asText();
    }
}
