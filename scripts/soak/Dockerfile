# scripts/soak/Dockerfile — standalone image for the 72h-soak load generator
# (SCRUM-2980). Independent of services/worker's Dockerfile/build — this
# image has zero runtime dependencies beyond Node's built-ins.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY loadgen.ts loadgen-server.ts ./
RUN npm run build

FROM node:20-alpine
RUN apk upgrade --no-cache
WORKDIR /app
COPY --from=builder /app/dist ./dist
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "dist/loadgen-server.js"]
