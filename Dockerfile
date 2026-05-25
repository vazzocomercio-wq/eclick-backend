FROM node:20-slim

# ffmpeg: encadeamento de vídeos (Kling). libxml2-utils (xmllint) + openssl:
# emissão de NF-e direta (node-sped-nfe valida o XML com xmllint e lê o .pfx
# via `pem`, que shella pro openssl) — o node:slim não traz esses binários.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg libxml2-utils openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && ls -la dist/

EXPOSE 3001
CMD ["node", "dist/main"]
