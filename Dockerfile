# terminal-lobby, single-user.
#
# One image, one account, no sudo. Multi-user needs `sudo -u` across real OS
# accounts on a shared kernel, which is a machine rather than a container; this
# image is the other mode, and it is the one a person self-hosting wants.
#
#   docker run -p 7681:7681 -v ~/work:/home/dev ghcr.io/viktorbarzin/terminal-lobby
#
# Authentication is still the proxy's job. With no proxy in front, ttyd's own
# basic auth is the shortest way to avoid publishing an open shell:
#
#   docker run -p 7681:7681 -e TL_BASIC_AUTH=me:secret ...

FROM golang:1.23-bookworm AS build
WORKDIR /src
# Each service is its own module, so they are copied and built independently
# rather than through one workspace.
COPY . .
RUN set -eux; \
    mkdir -p /out; \
    for svc in tmux-api file-api session-events skills-api clipboard-upload; do \
      (cd "$svc" && CGO_ENABLED=0 go build -trimpath -o "/out/$svc" ./...); \
    done

FROM node:22-bookworm AS web
WORKDIR /src/frontend-v2
COPY frontend-v2/package.json frontend-v2/package-lock.json ./
RUN npm ci
COPY frontend-v2/ ./
# The terminal iframe page is vendored xterm and lives outside frontend-v2; the
# build copies it into dist as an asset, so it has to be present.
COPY frontend/ /src/frontend/
RUN npm run build

FROM debian:bookworm-slim
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      tmux git ca-certificates curl procps less nano tini nginx openssl; \
    rm -rf /var/lib/apt/lists/*

# ttyd is not in Debian, so the upstream static build is pinned by digest.
#
# This is STOCK ttyd, not the patched build the devvm runs. That patch adds
# pixel-size reporting so tmux re-emits sixel, which is how images show inside a
# terminal here. Without it the lobby works and the Images button does not.
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
RUN set -eux; \
    curl -fsSL -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64"; \
    echo "${TTYD_SHA256}  /usr/local/bin/ttyd" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/ttyd

# One unprivileged account. The services resolve every request to this user
# because TL_MULTI_USER=off, and the same-user fast path means none of them
# ever calls sudo — which is why no sudo is installed.
RUN useradd --create-home --shell /bin/bash dev

COPY --from=build /out/ /usr/local/bin/
COPY --from=web /src/frontend-v2/dist/ /usr/local/share/ttyd/
COPY devvm/tmux-attach.sh /usr/local/bin/tmux-attach.sh
# tmux-user-attach re-homes the tmux server into the user's systemd scope so a
# ttyd restart does not kill every session. A container has no user manager, and
# the script already detects that and falls back to a plain attach, so it works
# here unmodified.
COPY devvm/tmux-user-attach /usr/local/bin/tmux-user-attach
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/nginx.conf.template /etc/nginx/nginx.conf.template
RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/tmux-attach.sh \
      /usr/local/bin/tmux-user-attach

# The services bind loopback: nginx is the only thing that reaches them, and it
# is in the same network namespace. Nothing outside the container can send an
# identity header directly at a service.
ENV TL_MULTI_USER=off \
    TL_AUTH_HEADER=X-Forwarded-User \
    TL_BIND=127.0.0.1 \
    TL_USER=dev

# The default. TL_PORT, or a PORT injected by a platform-as-a-service, moves
# the listener; EXPOSE is metadata and does not follow it.
EXPOSE 7681
# tini reaps: six processes under one entrypoint, and tmux leaves children.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
