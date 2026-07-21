FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core poppler-utils zip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY shell/server ./shell/server
COPY runtime-worker ./runtime-worker
USER node
CMD ["node", "runtime-worker/index.mjs"]
