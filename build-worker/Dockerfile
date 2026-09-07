FROM mcr.microsoft.com/playwright:v1.61.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY shell/server ./shell/server
# shell/server modules import shared contract vocabulary from shell/shared; without it the
# sandbox fails at import time (browser_verify exited 1 with ERR_MODULE_NOT_FOUND, 2026-09-07).
COPY shell/shared ./shell/shared
COPY harness ./harness
COPY build-worker ./build-worker
RUN mkdir -p /opt/scaffold \
  && node --input-type=module -e "import {writeFile} from 'node:fs/promises'; import {REACT_VITE} from './src/scaffolds/reactVite.mjs'; await writeFile('/opt/scaffold/package.json', REACT_VITE['package.json'])" \
  && cd /opt/scaffold \
  && npm install --ignore-scripts --no-audit --no-fund
# Bake the identity of the verdict-deciding code into the image. Without this an image cannot say
# what it is, and a stale pin grades builds silently — which is exactly what happened on
# 2026-08-10. Built from the same module the host uses, so the two identities are comparable.
ARG SOURCE_COMMIT=unknown
RUN node --input-type=module -e "\
import { writeFile } from 'node:fs/promises'; \
import { computeSandboxIdentity } from './shell/server/lib/builderV2/sandboxProvenance.mjs'; \
const identity = await computeSandboxIdentity({ root: '/app', commit: process.env.SOURCE_COMMIT || 'unknown' }); \
await writeFile('/app/sandbox-provenance.json', JSON.stringify({ ...identity, builtAt: new Date().toISOString() }, null, 2)); \
console.log(JSON.stringify(identity));" \
  && cat /app/sandbox-provenance.json
ENV SOURCE_COMMIT=$SOURCE_COMMIT

RUN mkdir -p /work /input /tmp/home && chown -R pwuser:pwuser /work /input /tmp/home
USER pwuser
ENV HOME=/tmp/home PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENTRYPOINT ["node", "build-worker/sandbox.mjs"]

