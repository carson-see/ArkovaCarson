# Arkova Worker — Cloud Run Build (multi-stage)
# SEC-013: Pin to specific Node version (not mutable lts-alpine tag)
# SEC-014: Run as non-root user

# Stage 1: Build (includes native build tools)
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production (minimal image, non-root)
FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && apk del python3 make g++
COPY --from=builder /app/dist ./dist

# SEC-014: Non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

ENV PORT=3001
EXPOSE 3001
CMD ["node", "--max-old-space-size=768", "dist/index.js"]
