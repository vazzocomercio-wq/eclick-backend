FROM node:20-alpine

WORKDIR /app

# libc6-compat: protobufjs/baileys precisa em Alpine.
# python3+make+g++: build de módulos nativos (libsignal usa node-gyp).
RUN apk add --no-cache libc6-compat python3 make g++

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Runtime sem build deps — runtime stage seria ideal, mas single-stage
# mantém Dockerfile simples conforme spec.
RUN npm prune --omit=dev

EXPOSE 3030
ENV WORKER_INTERNAL_PORT=3030

# CRÍTICO: bind em 0.0.0.0 pra Railway alcançar via private networking.
# Auth via header X-Internal-Key (INTERNAL_API_KEY) protege de acesso indevido.
ENV WORKER_INTERNAL_BIND=0.0.0.0

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_INTERNAL_PORT||3030)+'/internal/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 0

CMD ["node", "dist/index.js"]
