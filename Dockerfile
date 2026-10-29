FROM node:24-bookworm-slim AS frontend
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN corepack pnpm install --frozen-lockfile
COPY . .
RUN corepack pnpm build:ui

FROM golang:1.27.3-bookworm AS backend
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -o /ai-funnel ./cmd/funnel

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home funnel
WORKDIR /app
ENV HOST=0.0.0.0 PORT=4310 DATA_DIR=/app/data
COPY --from=backend /ai-funnel /app/ai-funnel
COPY --from=frontend /app/dist /app/dist
COPY LICENSES /app/LICENSES
RUN mkdir /app/data && chown funnel:funnel /app/data
USER funnel
VOLUME /app/data
EXPOSE 4310
CMD ["/app/ai-funnel"]
