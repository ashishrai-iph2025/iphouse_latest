# ── Stage 1: Build React frontend ────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /app

COPY package.json package-lock.json ./

# --ignore-scripts blocks pre/post-install hooks (the primary npm supply-chain
# attack vector). None of our 14 direct dependencies require install scripts.
RUN npm ci --ignore-scripts

# Fail the build on high/critical CVEs in anything that ships to the browser.
# Dev-only tooling (vite/esbuild) is excluded via --omit=dev: it never reaches
# the runtime image, so it must not be able to block a production deploy.
RUN npm audit --omit=dev --audit-level=high

COPY . .
RUN npm run build

# ── Stage 2: Build Go binary ──────────────────────────────────────────────────
FROM golang:1.24-alpine AS backend-builder
WORKDIR /build

COPY go-server/go.mod go-server/go.sum ./
RUN go mod download

COPY go-server/ .
RUN CGO_ENABLED=0 GOOS=linux go build -o iphouse-api .

# ── Stage 3: Minimal runtime image ───────────────────────────────────────────
FROM alpine:latest
RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app

# Copy Go binary
COPY --from=backend-builder /build/iphouse-api ./iphouse-api

# Copy built React frontend
COPY --from=frontend-builder /app/dist ./dist

EXPOSE 8080

CMD ["./iphouse-api"]
