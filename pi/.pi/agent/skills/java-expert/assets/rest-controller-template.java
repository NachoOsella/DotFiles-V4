package com.example.demo.controller;

import com.example.demo.dto.CreateRequest;
import com.example.demo.dto.UpdateRequest;
import com.example.demo.dto.EntityResponse;
import com.example.demo.service.EntityService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.util.UriComponentsBuilder;

import java.net.URI;
import java.util.List;

/**
 * Production-ready REST controller template for a CRUD resource.
 *
 * Copy this file, rename "Entity" to your domain object, and adjust
 * the request/response DTOs and service methods accordingly.
 */
@RestController
@RequestMapping("/api/entities")
@RequiredArgsConstructor
@Validated
public class EntityController {

    private final EntityService entityService;

    @GetMapping
    public List<EntityResponse> getAll() {
        return entityService.findAll();
    }

    @GetMapping("/{id}")
    public ResponseEntity<EntityResponse> getById(@PathVariable Long id) {
        return entityService.findById(id)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<EntityResponse> create(
            @Valid @RequestBody CreateRequest request,
            UriComponentsBuilder uriBuilder) {
        EntityResponse created = entityService.create(request);
        URI location = uriBuilder.path("/api/entities/{id}")
                .buildAndExpand(created.id())
                .toUri();
        return ResponseEntity.created(location).body(created);
    }

    @PutMapping("/{id}")
    public EntityResponse update(
            @PathVariable Long id,
            @Valid @RequestBody UpdateRequest request) {
        return entityService.update(id, request);
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        entityService.delete(id);
    }
}
