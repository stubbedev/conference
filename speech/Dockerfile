# syntax=docker/dockerfile:1

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/speech cmd/speech
COPY internal/speech internal/speech
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/speech ./cmd/speech

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/speech /speech
ENV PORT=8090
EXPOSE 8090
ENTRYPOINT ["/speech"]
