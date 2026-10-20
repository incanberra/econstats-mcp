# Keep the runtime aligned with the tested Bun version in GitHub Actions.
FROM oven/bun:1.3.10 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM dependencies AS faostat
# Keep the expensive public-data build cached when unrelated source code changes.
COPY scripts/build-faostat.ts ./scripts/build-faostat.ts
COPY src/core/faostat-catalog.ts ./src/core/faostat-catalog.ts
RUN bun run scripts/build-faostat.ts --output /app/faostat-data

FROM oven/bun:1.3.10-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    MCP_HOST=0.0.0.0 \
    PREFETCH_HOT_SERIES=false \
    ECONSTATS_DISK_CACHE=false
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=faostat --chown=bun:bun /app/faostat-data ./faostat-data
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun src ./src
USER bun
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
