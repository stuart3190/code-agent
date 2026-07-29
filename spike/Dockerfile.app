FROM node:22-alpine

WORKDIR /app

# Install deps first (cached layer — only re-runs when package.json changes)
COPY app/package.json ./
RUN npm install

# Copy app source (overwrites package.json with same content; node_modules untouched)
COPY app/ .

# Entrypoint writes per-container vite.config.js from env vars, then starts vite
COPY entrypoint.sh /entrypoint.sh
RUN chown -R node:node /app && chmod +x /entrypoint.sh

USER node
EXPOSE 5173
ENTRYPOINT ["/entrypoint.sh"]
