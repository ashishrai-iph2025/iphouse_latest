# ── Stage 1: Build React frontend ────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 2: Build Go binary ──────────────────────────────────────────────────
FROM golang:1.22-alpine AS backend-builder
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
