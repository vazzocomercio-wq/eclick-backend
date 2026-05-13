FROM node:20-slim

# ffmpeg necessário pra encadeamento de vídeos (Kling não tem tail_image
# nativo, então extraímos último frame e concatenamos MP4s).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && ls -la dist/

EXPOSE 3001
CMD ["node", "dist/main"]
