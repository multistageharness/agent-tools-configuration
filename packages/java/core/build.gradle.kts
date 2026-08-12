plugins {
    `java-library`
}

description = "Polyglot configuration discovery: the Spring-free core."

dependencies {
    // Jackson gives every format one tree type - JsonNode - which is what the merge is built on.
    api("com.fasterxml.jackson.core:jackson-databind:2.18.2")
    implementation("com.fasterxml.jackson.dataformat:jackson-dataformat-yaml:2.18.2")
    implementation("com.fasterxml.jackson.dataformat:jackson-dataformat-toml:2.18.2")
    implementation("io.github.cdimascio:dotenv-java:3.1.0")

    // Validation is detected reflectively at runtime and is never required: compileOnly, so it
    // does not reach a consumer's runtime classpath unless they put it there themselves.
    compileOnly("jakarta.validation:jakarta.validation-api:3.1.0")

    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testImplementation("jakarta.validation:jakarta.validation-api:3.1.0")
    testRuntimeOnly("org.hibernate.validator:hibernate-validator:8.0.2.Final")
    testRuntimeOnly("org.glassfish.expressly:expressly:5.0.0")
}

// The conformance probe: one fat jar, built once, then `java -jar` per fixture. Seventeen
// fixtures times a cold JVM plus a Gradle daemon check is slow enough that people stop running
// the suite.
val probeJar by tasks.registering(Jar::class) {
    archiveFileName.set("probe.jar")
    manifest {
        attributes("Main-Class" to "dev.configdiscovery.ConformanceProbe")
    }
    from(sourceSets.main.get().output)
    dependsOn(configurations.runtimeClasspath)
    from({
        configurations.runtimeClasspath.get()
            .filter { it.name.endsWith("jar") }
            .map { zipTree(it) }
    })
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    exclude("META-INF/*.SF", "META-INF/*.DSA", "META-INF/*.RSA", "module-info.class")
}

tasks.named("build") {
    dependsOn(probeJar)
}
