# Base image for preview containers. Scaffold deps are preinstalled (node_modules baked) so a
# provision is create + `docker cp <tree>` + start — no per-project `npm install` on the hot path.
# App SOURCE is injected at provision time, not baked (that was the spike's limitation).
FROM node:22-alpine

WORKDIR /app

# Install the fixed reactVite scaffold deps once (cached until package.json changes).
COPY package.json ./
RUN npm install

# The entrypoint writes vite.config.js from env, then runs the dev server.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown -R node:node /app

USER node
EXPOSE 5173
ENTRYPOINT ["/entrypoint.sh"]
