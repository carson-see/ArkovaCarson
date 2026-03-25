# Arkova Worker — Cloud Run Build (multi-stage)

# Stage 1: Build
FROM node:lts-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production
FROM node:lts-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/index.js"]
