# Agentrail in one container: the server, the dashboard, and a SQLite file in /data.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY . .
RUN npm run build -w @agentrail/web

FROM node:24-slim
WORKDIR /app
ENV AGENTRAIL_DATA_DIR=/data PORT=4318
COPY --from=build /app /app
VOLUME /data
EXPOSE 4318
# The server runs from source with Node's type stripping, so there is no build step to forget.
CMD ["node", "--conditions=source", "packages/server/src/main.ts"]
