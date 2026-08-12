// Two modules, deliberately.
//
// `core` satisfies packages/spec/SPEC.md with no Spring on its classpath at all, so a plain
// application - a CLI, a library, anything - can depend on it without dragging in a framework.
// `spring` is an optional adapter that exposes the same discovery through Spring Boot's own
// property-source mechanism, so `@ConfigurationProperties` and relaxed binding keep working.
//
// Reversing this later means either forcing Spring on every consumer or breaking the Spring
// integration's package layout. It is the decision in this build most likely to be "simplified"
// away by a later reader, so: the `:core:dependencies` check in CI exists to stop that.

plugins {
    `java-library`
    `maven-publish`
}

subprojects {
    apply(plugin = "java-library")
    apply(plugin = "maven-publish")

    group = "io.github.multistageharness"
    version = "0.1.0"

    repositories {
        mavenCentral()
    }

    // One release level for both modules. Not a toolchain block: pinning a toolchain version
    // makes the build fail on any machine without that exact JDK, and `release` gives the same
    // guarantee - bytecode and API surface for Java 21 - using whatever JDK is present.
    tasks.withType<JavaCompile>().configureEach {
        options.release.set(21)
        options.compilerArgs.add("-Xlint:all")
    }

    tasks.withType<Javadoc>().configureEach {
        // Check what javadoc is for - broken references and bad syntax - without demanding an
        // @param on every one-line builder setter, which adds noise rather than meaning.
        (options as StandardJavadocDocletOptions).addStringOption("Xdoclint:all,-missing", "-quiet")
    }

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
        testLogging {
            events("failed")
            showStackTraces = true
            exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        }
    }

    // Maven Central rejects an artifact without sources, javadoc, and a fully populated POM -
    // and it rejects it *after* upload, at validation. Configuring it here means
    // `./gradlew publish` in packages/java/RELEASE.md is a command that exists.
    //
    // The groupId is io.github.multistageharness rather than dev.configdiscovery because Central
    // verifies namespace ownership, and a dev.* namespace needs the domain. See RELEASE.md.
    the<JavaPluginExtension>().withSourcesJar()
    the<JavaPluginExtension>().withJavadocJar()

    afterEvaluate {
        extensions.configure<PublishingExtension> {
            publications {
                create<MavenPublication>("maven") {
                    artifactId = "config-discovery-" + project.name
                    from(components["java"])
                    pom {
                        name.set("config-discovery-" + project.name)
                        description.set(project.description ?: "Polyglot configuration discovery")
                        url.set("https://github.com/multistageharness/agent-tools-configuration")
                        licenses {
                            license {
                                name.set("MIT")
                                url.set("https://opensource.org/licenses/MIT")
                            }
                        }
                        developers {
                            developer {
                                id.set("multistageharness")
                                name.set("Multi Stage Harness")
                            }
                        }
                        scm {
                            url.set("https://github.com/multistageharness/agent-tools-configuration")
                            connection.set(
                                "scm:git:https://github.com/multistageharness/agent-tools-configuration.git")
                        }
                    }
                }
            }
        }
    }
}
