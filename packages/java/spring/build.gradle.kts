plugins {
    `java-library`
}

description = "Polyglot configuration discovery: the optional Spring Boot adapter."

dependencies {
    api(project(":core"))
    implementation("org.springframework.boot:spring-boot:3.4.1")

    testImplementation("org.springframework.boot:spring-boot-starter-test:3.4.1")
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
