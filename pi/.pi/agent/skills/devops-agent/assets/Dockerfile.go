# Multi-stage Dockerfile template for Go applications
# Targets: dependencies, build, production
# Best practices: static binary, distroless/scratch final image, non-root

# ---- Dependencies ----
FROM golang:1.22-alpine AS dependencies
WORKDIR /app
RUN apk add --no-cache git ca-certificates tzdata

COPY go.mod go.sum ./
RUN go mod download && go mod verify

# ---- Build ----
FROM golang:1.22-alpine AS build
WORKDIR /app

# Security: do not run as root during build
RUN adduser -D -g '' builder

COPY --from=dependencies /go/pkg /go/pkg
COPY . .

# Build static binary with security flags
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags='-w -s -extldflags "-static"' \
    -a -installsuffix cgo \
    -o /app/server \
    ./cmd/server

# ---- Production ----
# Option A: gcr.io/distroless/static (recommended for most apps)
FROM gcr.io/distroless/static:nonroot AS production
COPY --from=build /app/server /server
COPY --from=dependencies /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=dependencies /usr/share/zoneinfo /usr/share/zoneinfo

USER nonroot:nonroot
EXPOSE 8080

ENTRYPOINT ["/server"]

# Option B: scratch (smallest possible image, no shell, no utilities)
# FROM scratch AS production-scratch
# COPY --from=build /app/server /server
# COPY --from=dependencies /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# COPY --from=dependencies /usr/share/zoneinfo /usr/share/zoneinfo
# EXPOSE 8080
# ENTRYPOINT ["/server"]
