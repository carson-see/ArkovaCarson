# Arkova Worker — Railway Build (minimal, single-stage)
FROM node:lts-alpine
WORKDIR /app

# Copy manifests and install ALL deps (need typescript for build)
COPY package.json package-lock.json ./
RUN npm install

# Copy source and build
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --omit=dev && npm cache clean --force

# Remove source (only need compiled dist/)
RUN rm -rf src/ tsconfig.json tsconfig.build.json

ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/index.js"]
