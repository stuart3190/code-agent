# Custom Caddy with the Cloudflare DNS plugin (the stock caddy:2-alpine lacks DNS providers).
# Needed for DNS-01 wildcard issuance of *.preview.buildr101.com. Built on the VPS host (has
# internet); app containers stay --internal.
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
