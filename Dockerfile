FROM node:22-alpine
WORKDIR /app
COPY package.json ./
# laz-perf (LAZ support) is the only dependency and it is optional: the image still works if it cannot be fetched.
RUN npm install --omit=dev --no-audit --no-fund || true
COPY server ./server
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server/index.js"]
