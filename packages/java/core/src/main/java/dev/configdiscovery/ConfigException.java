package dev.configdiscovery;

/**
 * Every failure this library reports, carrying a machine-readable {@link Kind} from the closed
 * list in SPEC section 5.
 *
 * <p>Callers switch on {@link #kind()}; nothing should match on message text, which differs per
 * parser and per language.
 */
public final class ConfigException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    /** The closed list of SPEC section 5 error kinds. */
    public enum Kind {
        /**
         * No recognized file at any root. <strong>Never thrown</strong> - nothing found is a
         * success with {@code found = false}. The constant exists so a caller can name it.
         */
        NOT_FOUND("not-found"),
        /** A recognized file exists but cannot be read. */
        UNREADABLE("unreadable"),
        /** A parser rejected the file. */
        MALFORMED("malformed"),
        /** {@code config.yaml} beside {@code config.yml} in one directory. */
        DUPLICATE_FORMAT("duplicate-format"),
        /** A key the caller's type does not declare, under strict mode. */
        UNKNOWN_KEY("unknown-key"),
        /** A value failed the caller's type or its constraints. */
        VALIDATION("validation");

        private final String wireName;

        Kind(String wireName) {
            this.wireName = wireName;
        }

        /** The kind string SPEC section 5 and the conformance probe use. */
        public String wireName() {
            return wireName;
        }
    }

    private final Kind kind;
    private final String path;
    private final int line;
    private final int column;
    private final String keyPath;

    private ConfigException(
            Kind kind, String message, String path, int line, int column, String keyPath, Throwable cause) {
        super(message, cause);
        this.kind = kind;
        this.path = path;
        this.line = line;
        this.column = column;
        this.keyPath = keyPath;
    }

    /** An error about a file or directory. */
    public static ConfigException of(Kind kind, String path, String message, Throwable cause) {
        return new ConfigException(kind, describe(kind, path, message), path, 0, 0, null, cause);
    }

    /** A parse failure that knows where in the file it happened. */
    public static ConfigException malformed(String path, int line, int column, String message, Throwable cause) {
        String where = line > 0 ? path + ":" + line : path;
        return new ConfigException(
                Kind.MALFORMED, describe(Kind.MALFORMED, where, message), path, line, column, null, cause);
    }

    /** An error about a key rather than a file. */
    public static ConfigException ofKey(Kind kind, String keyPath, String message, Throwable cause) {
        return new ConfigException(kind, describe(kind, keyPath, message), null, 0, 0, keyPath, cause);
    }

    private static String describe(Kind kind, String subject, String message) {
        StringBuilder text = new StringBuilder(kind.wireName());
        if (subject != null && !subject.isBlank()) {
            text.append(": ").append(subject);
        }
        if (message != null && !message.isBlank()) {
            text.append(": ").append(message);
        }
        return text.toString();
    }

    /** The SPEC section 5 kind. */
    public Kind kind() {
        return kind;
    }

    /** The file or directory this error is about, or {@code null}. */
    public String path() {
        return path;
    }

    /** One-based line, or {@code 0} when the parser did not report one. */
    public int line() {
        return line;
    }

    /** One-based column, or {@code 0} when the parser did not report one. */
    public int column() {
        return column;
    }

    /** The dotted key path this error is about, or {@code null}. */
    public String keyPath() {
        return keyPath;
    }
}
