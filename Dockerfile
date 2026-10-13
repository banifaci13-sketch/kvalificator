# Docker Hub недоступен с российских серверов — по умолчанию берём образ с зеркала Google
ARG NODE_IMAGE=mirror.gcr.io/library/node:22-alpine
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
# Chromium — для PDF и проверки вёрстки презентаций; DejaVu — запасной шрифт (фирменные встроены в документы)
RUN apk add --no-cache chromium font-dejavu
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY config ./config
COPY src ./src
COPY widget ./widget
COPY admin ./admin
COPY scripts ./scripts
COPY brand ./brand
COPY templates ./templates
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
