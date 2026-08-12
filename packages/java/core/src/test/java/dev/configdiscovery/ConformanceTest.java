package dev.configdiscovery;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.File;
import java.nio.file.Path;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

/**
 * The cross-language conformance suite, run as part of this module's own tests.
 *
 * <p>A conformance regression should fail {@code ./gradlew test}, not only CI.
 */
class ConformanceTest {

    @Test
    void everyFixturePasses() throws Exception {
        Assumptions.assumeTrue(onPath("node"), "the conformance runner needs node");

        // Gradle runs tests with the module directory as the working directory, so walk up
        // until the runner is in sight rather than counting levels.
        Path repoRoot = Path.of("").toAbsolutePath();
        while (repoRoot != null && !java.nio.file.Files.exists(repoRoot.resolve("packages/spec/runner/run.mjs"))) {
            repoRoot = repoRoot.getParent();
        }
        Assumptions.assumeTrue(repoRoot != null, "could not locate the repository root");
        Process process = new ProcessBuilder(
                        "node", repoRoot.resolve("packages/spec/runner/run.mjs").toString(), "--probe", "java")
                .directory(repoRoot.toFile())
                .redirectErrorStream(true)
                .start();
        String output = new String(process.getInputStream().readAllBytes());
        assertEquals(0, process.waitFor(), output);
    }

    private static boolean onPath(String command) {
        String path = System.getenv("PATH");
        if (path == null) {
            return false;
        }
        for (String directory : path.split(File.pathSeparator)) {
            if (new File(directory, command).canExecute()) {
                return true;
            }
        }
        return false;
    }
}
