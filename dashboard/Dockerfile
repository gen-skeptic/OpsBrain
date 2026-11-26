# syntax=docker/dockerfile:1
# OpsBrain dashboard: the Open Brain dashboard (Next.js) for people, talking to OpsBrain's Open Brain REST API.
#   docker build -t opsbrain-dashboard dashboard/
# Behind a TLS-inspecting proxy, add: --secret id=ca,src=/path/to/ca.crt
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --no-audit --no-fund
COPY . .
# Where the dashboard's server reaches OpsBrain (the browser never calls it), and the Dautel theme.
ARG OPSBRAIN_API_URL=http://opsbrain:8787/open-brain-rest
ARG OPSBRAIN_UI_THEME=dautel
# The session secret is only needed to load the modules during the build; the real one comes at runtime.
RUN NEXT_PUBLIC_API_URL="$OPSBRAIN_API_URL" OPSBRAIN_UI_THEME="$OPSBRAIN_UI_THEME" \
    SESSION_SECRET=build-time-placeholder-never-used-at-runtime npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/login').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server.js"]
