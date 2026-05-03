FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && ls -la dist/

EXPOSE 3001
CMD ["node", "dist/main"]
