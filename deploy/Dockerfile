# OpsBrain server, migrations, admin CLI and PARA exporter in one image.
# Build from the repository root:  docker build -f deploy/Dockerfile -t opsbrain .
FROM denoland/deno:2.5.6

WORKDIR /app
COPY deno.json deno.lock ./
COPY server/ server/
COPY db/ db/
COPY admin/ admin/
COPY para/ para/

# git is needed only when PARA_GIT_COMMIT=true.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && deno cache --frozen server/index.ts db/migrate.ts admin/opsbrain-admin.ts para/export.ts para/schedule.ts \
 && mkdir -p /data/para /data/para-restricted && chown -R deno:deno /app /data /deno-dir

USER deno
ENV OPSBRAIN_HOST=0.0.0.0 OPSBRAIN_PORT=8787 PARA_OUTPUT_DIR=/data/para
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=3s --retries=3 \
  CMD ["deno", "eval", "const r = await fetch('http://127.0.0.1:8787/healthz'); if (!r.ok) Deno.exit(1)"]

# Default: apply migrations, then serve. Override the command for the exporter or admin CLI.
CMD ["task", "start"]
