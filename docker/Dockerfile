# Image JsMyData — construite depuis la racine du dépôt :
#   docker build -f docker/Dockerfile -t jsmydata/jsmydata .
FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/sql/package.json packages/sql/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    JSMYDATA_LISTEN_HOST=0.0.0.0 \
    JSMYDATA_LISTEN_PORT=8080 \
    JSMYDATA_SQLITE_DIR=/data
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./dist
RUN mkdir -p /data /home/node/.jsmydata && chown -R node:node /data /home/node/.jsmydata
USER node
VOLUME ["/data", "/home/node/.jsmydata"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/cli.js"]
