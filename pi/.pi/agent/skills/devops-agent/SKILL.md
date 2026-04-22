---
name: devops-agent
description: "Creates and audits Infrastructure as Code including Docker, CI/CD pipelines, and Terraform configurations. Use when you need to: (1) create or optimize Dockerfiles, (2) set up CI/CD pipelines (GitHub Actions, GitLab CI, Jenkins), (3) write Terraform or Kubernetes manifests, (4) audit existing infrastructure configurations, or (5) implement deployment automation."
---

## Core Actions

**Containerization**
- Create multi-stage Dockerfiles with minimal base images (Alpine/Distroless)
- Never run containers as root
- Optimize layer caching for faster builds
- Pin image tags to specific versions (never use `latest` in production)
- Include `HEALTHCHECK` in production images

**CI/CD Pipelines**
- Create workflow files for GitHub Actions, GitLab CI, or Jenkins
- Include caching, linting, testing, security scanning, and deployment stages
- Use environment protection rules for staging and production gates
- Reference secrets with correct syntax: `${{ secrets.SECRET_NAME }}` in GitHub Actions

**Infrastructure**
- Write Terraform modules with input validation, locals, and outputs
- Write Kubernetes manifests with resource limits, security contexts, probes, and anti-affinity
- Use environment variables or secret management for secrets (never hardcode)
- Tag all cloud resources for cost tracking and lifecycle management

## Operational Rules

- Use `write`/`edit` tools to create files directly (not code blocks in chat)
- Read existing configurations before overwriting to preserve custom logic
- Scan for hardcoded secrets and replace with environment variable references
- Run validation before committing: lint, build, and test locally when possible

## Assets

The `assets/` directory contains production-ready templates:

| File | Description |
|------|-------------|
| `assets/Dockerfile.node` | Multi-stage Node.js Dockerfile with pnpm/yarn/npm support, non-root user, dumb-init |
| `assets/Dockerfile.python` | Multi-stage Python Dockerfile with virtualenv, slim base, non-root user |
| `assets/Dockerfile.go` | Multi-stage Go Dockerfile with static binary, distroless/scratch final image |
| `assets/github-actions-template.yml` | Complete GitHub Actions workflow: lint, test, build, scan, deploy with staging/production gates |
| `assets/terraform-module-template.tf` | Terraform module with variables, validation, locals, data sources, outputs |
| `assets/kubernetes-manifest-template.yml` | Full K8s manifest: Deployment, Service, HPA, PodDisruptionBudget with security contexts |

Copy the relevant template and customize for the project.

## Scripts

The `scripts/` directory contains validation and scanning tools:

| Script | Description |
|--------|-------------|
| `scripts/scan-secrets.sh` | Scans code for hardcoded secrets (AWS keys, tokens, passwords, private keys, DB URLs). Usage: `./scan-secrets.sh [directory] [--fail-on-findings]` |
| `scripts/validate-dockerfile.sh` | Validates Dockerfiles with hadolint (if installed) plus structural checks. Usage: `./validate-dockerfile.sh <Dockerfile> [--strict]` |

## Step-by-Step Procedures

### Audit Existing Configuration

1. **Inventory**: List all IaC files (`Dockerfile`, `.yml`, `.tf`, `.yaml` manifests).
2. **Read**: Open each file and note custom logic that must be preserved.
3. **Scan secrets**: Run `scripts/scan-secrets.sh` against the repository.
4. **Validate Dockerfiles**: Run `scripts/validate-dockerfile.sh` on each `Dockerfile`.
5. **Check tags**: Ensure no `:latest` tags and no hardcoded versions in base images.
6. **Check root**: Verify `USER` instruction exists in every `Dockerfile`.
7. **Check CI/CD**: Verify secrets use `${{ secrets.NAME }}` syntax (not `$SECRET` or `${SECRET}`). Verify environment blocks exist for production deploy jobs.
8. **Check Terraform**: Verify `required_providers`, input validation blocks, and encrypted state backend.
9. **Check Kubernetes**: Verify `resources`, `securityContext`, `livenessProbe`, `readinessProbe`, and `PodDisruptionBudget` are present.
10. **Document findings**: Create a summary of issues found and recommended fixes.

### Create From Scratch

1. **Choose templates**: Select the appropriate `Dockerfile.*` and `assets/*.yml` / `assets/*.tf` templates.
2. **Customize**: Replace placeholders (`myapp`, `example.com`, ports, paths) with project-specific values.
3. **Add secrets references**: Replace any placeholder secrets with `${{ secrets.NAME }}` (CI) or `var.secret_name` / Kubernetes `secretRef`.
4. **Lint**: Run `scripts/validate-dockerfile.sh` on new Dockerfiles.
5. **Scan**: Run `scripts/scan-secrets.sh` to ensure no secrets were accidentally included.
6. **Test build**: Run `docker build` locally before pushing. See Validation Loop below.
7. **Commit**: Create the files in the repository and confirm paths.

## Validation Loop

Always test builds before pushing. Follow this loop for every Dockerfile or CI change:

1. **Build locally**:
   ```bash
   docker build --target production -t myapp:test .
   ```
2. **Run and verify**:
   ```bash
   docker run --rm -p 3000:3000 myapp:test
   ```
   Check that the container starts, logs look correct, and health endpoints respond.
3. **Inspect image**:
   ```bash
   docker run --rm -it myapp:test sh
   ```
   Verify the user is non-root (`whoami`), files have correct ownership, and no secrets are present in env or filesystem.
4. **Scan image**:
   ```bash
   # Using Trivy
   trivy image myapp:test
   # Or using Grype
   grype myapp:test
   ```
5. **Size check**:
   ```bash
   docker images myapp:test
   ```
   Confirm the final image size is reasonable. If it is unexpectedly large, check for leftover build artifacts, caches, or unnecessary layers.
6. **If CI changes**: push to a feature branch and open a draft PR to verify the pipeline runs correctly without deploying.
7. **Only after success**: push to main or merge the PR.

## Gotchas

| Gotcha | Impact | Fix |
|--------|--------|-----|
| **Docker layer caching** | Changing any file early in the Dockerfile invalidates all subsequent layer caches, slowing builds. | Order instructions by change frequency: base image first, then dependency install (copy lockfiles alone), then source code last. |
| **Never use `latest`** | `latest` is mutable; builds are non-reproducible and can break silently when upstream updates. | Pin to a specific version tag (`node:20-alpine`, `python:3.12-slim`). Use a digest for maximum reproducibility (`node:20-alpine@sha256:...`). |
| **GitHub Actions secrets syntax** | Using `$SECRET` or `${SECRET}` instead of `${{ secrets.SECRET }}` prints the literal string or fails at runtime. | Always use the `${{ secrets.SECRET_NAME }}` context expression. For env vars mapped from secrets, use `env: MY_VAR: ${{ secrets.MY_VAR }}`. |
| **Missing `USER` instruction** | Containers run as root by default, increasing attack surface if compromised. | Add a non-root user with `RUN adduser` and set `USER` before `CMD`/`ENTRYPOINT`. |
| **Hardcoded secrets in env vars** | Secrets committed to source control are exposed forever in git history. | Use secret managers (AWS Secrets Manager, HashiCorp Vault, GitHub Secrets, Kubernetes Secrets). Run `scripts/scan-secrets.sh` in CI. |
| **No resource limits in K8s** | A runaway pod can exhaust cluster resources and cause outages. | Always set `resources.requests` and `resources.limits` for CPU and memory. |
| **Terraform state local** | Local state is not shareable and is lost if the machine fails. | Configure a remote backend (S3 + DynamoDB, Terraform Cloud, GCS) with state locking and encryption. |
| **apt-get without cleanup** | Layer bloat from package lists and caches increases image size. | Chain install and cleanup in a single `RUN`: `apt-get update && apt-get install -y ... && rm -rf /var/lib/apt/lists/*`. |
| **Health checks missing** | Orchestrators cannot detect unhealthy containers automatically. | Add `HEALTHCHECK` to Dockerfiles and `livenessProbe`/`readinessProbe` to Kubernetes manifests. |

## Output

Confirm files created/edited and briefly explain the strategy used. Include any warnings from the validation loop or secret scan.
