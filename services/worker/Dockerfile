# Arkova Worker — Cloud Run Build (multi-stage)

# Stage 1: Build
FROM node:lts-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production
FROM node:lts-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && apk del python3 make g++
COPY --from=builder /app/dist ./dist
ENV PORT=3001
EXPOSE 3001
CMD ["node", "--max-old-space-size=768", "dist/index.js"]
