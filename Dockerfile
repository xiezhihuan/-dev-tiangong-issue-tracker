FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev \
 && find node_modules/onnxruntime-node/bin -mindepth 2 -maxdepth 2 -type d ! -name linux -exec rm -rf {} +

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/app/data TZ=Asia/Shanghai
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY models ./models
RUN mkdir -p data && chown node:node data
USER node
VOLUME /app/data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/main.js"]
