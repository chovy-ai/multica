# Build from the repository root:
#   docker build -f deploy/p2p-server/Dockerfile -t p2p-server .
FROM golang:1.27.3-alpine AS build
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/p2p-server ./cmd/p2p-server

FROM alpine:3.21
# ca-certificates: the registry verifies tokens against https://api.multica.ai.
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/p2p-server /usr/local/bin/p2p-server
# Matches the owner of the host data directory created by deploy.sh.
USER 10001:10001
WORKDIR /var/lib/multica-p2p
ENTRYPOINT ["/usr/local/bin/p2p-server"]
