FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY config ./config
COPY src ./src
COPY widget ./widget
COPY scripts ./scripts
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
EXPOSE 3000
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
