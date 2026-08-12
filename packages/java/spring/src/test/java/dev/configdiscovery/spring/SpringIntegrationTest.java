package dev.configdiscovery.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * Proves the adapter inside a real Spring context: the discovery runs, the values land in the
 * environment, and a {@code @ConfigurationProperties} bean binds from them.
 */
class SpringIntegrationTest {

    @SpringBootApplication
    @EnableConfigurationProperties(LogProperties.class)
    static class TestApplication {}

    @ConfigurationProperties(prefix = "log")
    public static class LogProperties {
        private String level;

        public String getLevel() {
            return level;
        }

        public void setLevel(String level) {
            this.level = level;
        }
    }

    @Test
    void projectLocalOverridesUserLevelInsideASpringContext(@TempDir Path temp) throws IOException {
        Files.createDirectories(temp.resolve("project/.config/mytool"));
        Files.createDirectories(temp.resolve("home/.config/mytool"));
        Files.writeString(temp.resolve("project/.git"), "");
        Files.writeString(temp.resolve("project/.config/mytool/config.toml"), "[log]\nlevel = \"debug\"\n");
        Files.writeString(temp.resolve("home/.config/mytool/config.toml"), "[log]\nlevel = \"info\"\n");

        try (ConfigurableApplicationContext context = new SpringApplicationBuilderish()
                .run(
                        "--config-discovery.package-name=mytool",
                        "--config-discovery.cwd=" + temp.resolve("project"),
                        "--config-discovery.home=" + temp.resolve("home"))) {
            assertEquals("debug", context.getEnvironment().getProperty("log.level"));
            assertEquals("debug", context.getBean(LogProperties.class).getLevel());
        }
    }

    /** A tiny launcher so the test does not need spring-boot-starter-web on the classpath. */
    private static final class SpringApplicationBuilderish {
        ConfigurableApplicationContext run(String... args) {
            SpringApplication application = new SpringApplication(TestApplication.class);
            application.setWebApplicationType(WebApplicationType.NONE);
            application.setBannerMode(org.springframework.boot.Banner.Mode.OFF);
            return application.run(args);
        }
    }
}
