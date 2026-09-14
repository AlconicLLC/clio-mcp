# Debian (glibc), not Alpine: @napi-rs/keyring ships a linux-x64-gnu prebuild
# and HTTP mode must still be able to import that module even though tokens
# live in memory.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm ci && npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/build ./build
EXPOSE 3000
CMD ["node", "build/index.js"]
