# syntax=docker/dockerfile:1

FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/conference ./cmd/server \
    && mkdir -p /out/data \
    && chown 65532:65532 /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/conference /conference
COPY --from=build /out/data /data
ENV DB_PATH=/data/conference.db PORT=8080 ICE_UDP_PORT=5000
EXPOSE 8080
EXPOSE 5000/udp
VOLUME /data
ENTRYPOINT ["/conference"]
