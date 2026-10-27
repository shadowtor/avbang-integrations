# Self-host AVBang Plex provider. Build context is the integrations/ directory (the split repo root):
#   docker build -f plex/Dockerfile -t avbang-plex-provider .
# No packages are installed and nothing is built; Node strips the TypeScript types at start.
FROM node:26.11.1-trixie-slim

ENV NODE_ENV=production \
    BIND=0.0.0.0 \
    PORT=8787
WORKDIR /app
COPY --chown=root:root package.json ./
COPY --chown=root:root plex/provider.ts plex/server.ts ./plex/

# Unprivileged user; the files stay root-owned and read-only to it. The key is read from AVBANG_API_KEY at run time.
USER node
EXPOSE 8787
# Any HTTP answer below 500 means the server is up (with PROVIDER_TOKEN set, "/" is a 404 by design).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node", "plex/server.ts"]
