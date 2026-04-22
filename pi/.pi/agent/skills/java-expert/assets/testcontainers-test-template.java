package com.example.demo;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Integration test template using Testcontainers with PostgreSQL.
 *
 * This template spins up a real PostgreSQL container, wires it into the
 * Spring context, and runs the full application stack (controller -> service -> repository -> DB).
 *
 * Usage:
 * 1. Ensure test dependencies are present:
 *    testImplementation 'org.testcontainers:junit-jupiter:1.19.0'
 *    testImplementation 'org.testcontainers:postgresql:1.19.0'
 *    testImplementation 'org.springframework.boot:spring-boot-starter-test'
 *
 * 2. Copy this file into src/test/java and rename/adapt for your domain.
 */
@Testcontainers
@SpringBootTest
@AutoConfigureMockMvc
public class IntegrationTestTemplate {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:15-alpine")
            .withDatabaseName("testdb")
            .withUsername("testuser")
            .withPassword("testpass");

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
        registry.add("spring.datasource.driver-class-name", postgres::getDriverClassName);
        registry.add("spring.jpa.hibernate.ddl-auto", () -> "create-drop");
    }

    @Autowired
    private MockMvc mockMvc;

    @Test
    void contextLoads() {
        // Verifies that the Spring context starts successfully with the PostgreSQL container
    }

    @Test
    void shouldReturnNotFoundForUnknownResource() throws Exception {
        mockMvc.perform(get("/api/entities/99999"))
                .andExpect(status().isNotFound());
    }

    // Add more tests here:
    // - POST to create a resource, then GET to verify
    // - PUT to update, then assert changed fields
    // - DELETE to remove, then assert 404 on subsequent GET
}
