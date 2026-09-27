# PPM reverse proxy: stock Caddy (no DNS/L4 plugins are needed for HTTP-01/TLS-ALPN ACME) + the PPM Caddyfile.
# ppm-build.sh passes CADDY_IMAGE pinned by digest.
ARG CADDY_IMAGE=caddy:2.11.3-alpine
FROM ${CADDY_IMAGE}

COPY Caddyfile /etc/caddy/Caddyfile

# The admin API only listens inside the container (localhost:2019); it doubles as a liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:2019/config/ || exit 1
