package dev.configdiscovery;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import java.lang.reflect.Method;
import java.util.stream.Collectors;

/**
 * Binding the merged configuration to a caller's type, plus optional Jakarta Bean Validation.
 *
 * <p>Validation is detected reflectively, so {@code jakarta.validation-api} stays
 * {@code compileOnly}: a consumer who wants constraint checking puts a validator on their
 * classpath, and one who does not pays nothing and sees no failure.
 */
public final class Binding {

    /**
     * Coercion is deliberately off. The spec already coerced at load time (SPEC section 4.5), and
     * coercing a second time here would repair data rather than report it - which hides the bug
     * instead of surfacing it.
     */
    static final ObjectMapper MAPPER = new ObjectMapper()
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .disable(DeserializationFeature.ACCEPT_SINGLE_VALUE_AS_ARRAY)
            .disable(DeserializationFeature.ACCEPT_EMPTY_STRING_AS_NULL_OBJECT);

    private static final ObjectMapper STRICT_MAPPER = MAPPER.copy()
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);

    private Binding() {}

    /** Bind {@code config} to {@code type}, then validate it if a validator is available. */
    public static <T> T as(JsonNode config, Class<T> type, LoadOptions options) {
        T bound;
        try {
            bound = (options.strict() ? STRICT_MAPPER : MAPPER).treeToValue(config, type);
        } catch (UnrecognizedPropertyException unknown) {
            throw ConfigException.ofKey(
                    ConfigException.Kind.UNKNOWN_KEY,
                    pathOf(unknown),
                    "no such property on " + type.getSimpleName(),
                    unknown);
        } catch (JsonMappingException mismatch) {
            throw ConfigException.ofKey(
                    ConfigException.Kind.VALIDATION, pathOf(mismatch), mismatch.getOriginalMessage(), mismatch);
        } catch (Exception cause) {
            throw ConfigException.ofKey(ConfigException.Kind.VALIDATION, null, cause.getMessage(), cause);
        }
        validate(bound);
        return bound;
    }

    private static String pathOf(JsonMappingException exception) {
        if (exception.getPath() == null || exception.getPath().isEmpty()) {
            return null;
        }
        return exception.getPath().stream()
                .map(reference -> reference.getFieldName() == null
                        ? "[" + reference.getIndex() + "]"
                        : reference.getFieldName())
                .collect(Collectors.joining("."));
    }

    /**
     * Run Jakarta Bean Validation when it is on the classpath, and do nothing when it is not.
     *
     * <p>Reflective on purpose: a hard reference would make {@code jakarta.validation-api} a
     * runtime dependency of every consumer, which is exactly what {@code compileOnly} is there to
     * prevent.
     */
    private static void validate(Object bound) {
        Object validator;
        try {
            Class<?> validation = Class.forName("jakarta.validation.Validation");
            Method buildFactory = validation.getMethod("buildDefaultValidatorFactory");
            Object factory = buildFactory.invoke(null);
            validator = factory.getClass().getMethod("getValidator").invoke(factory);
        } catch (ReflectiveOperationException | RuntimeException absent) {
            return; // No validator on the classpath: nothing to do, and not an error.
        }

        try {
            Method validateMethod = validator.getClass().getMethod("validate", Object.class, Class[].class);
            validateMethod.setAccessible(true);
            Object violations = validateMethod.invoke(validator, bound, new Class<?>[0]);
            for (Object violation : (Iterable<?>) violations) {
                String keyPath = violation.getClass().getMethod("getPropertyPath").invoke(violation).toString();
                String message = (String) violation.getClass().getMethod("getMessage").invoke(violation);
                throw ConfigException.ofKey(ConfigException.Kind.VALIDATION, keyPath, message, null);
            }
        } catch (ReflectiveOperationException cause) {
            throw ConfigException.ofKey(
                    ConfigException.Kind.VALIDATION, null, "validation failed to run: " + cause, cause);
        }
    }
}
