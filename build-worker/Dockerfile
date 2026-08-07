FROM mcr.microsoft.com/playwright:v1.61.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY shell/server ./shell/server
COPY harness ./harness
COPY build-worker ./build-worker
RUN mkdir -p /opt/scaffold \
  && node --input-type=module -e "import {writeFile} from 'node:fs/promises'; import {REACT_VITE} from './src/scaffolds/reactVite.mjs'; await writeFile('/opt/scaffold/package.json', REACT_VITE['package.json'])" \
  && cd /opt/scaffold \
  && npm install --ignore-scripts --no-audit --no-fund
RUN mkdir -p /work /input /tmp/home && chown -R pwuser:pwuser /work /input /tmp/home
USER pwuser
ENV HOME=/tmp/home PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENTRYPOINT ["node", "build-worker/sandbox.mjs"]

