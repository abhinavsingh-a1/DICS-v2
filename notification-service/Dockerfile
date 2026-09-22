# Multi-stage build — standard Go pattern: compile in a full Go image,
# then copy ONLY the resulting static binary into a minimal runtime
# image. The build stage (with the whole Go toolchain, ~800MB) never
# ships; the final image is just the ~15MB binary plus a tiny base OS.
# This is a different shape from this project's other Dockerfiles
# (Python/Node images ship an interpreter plus source, since those
# languages can't compile to one standalone binary) — worth noticing as
# a genuine, language-driven difference, not an inconsistency.

FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /notification-service .

FROM gcr.io/distroless/static-debian12
COPY --from=build /notification-service /notification-service
ENTRYPOINT ["/notification-service"]
