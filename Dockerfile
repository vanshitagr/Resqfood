# Node 22 is the floor: server/database.js uses the built-in node:sqlite module and the
# start command uses --env-file-if-exists, neither of which exists in Node 18/20.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Dependencies first so a code change does not invalidate the install layer.
# --omit=dev leaves out puppeteer-core, which is only needed to run the UI test.
# Every runtime dependency (express, pg, bcryptjs, jsonwebtoken) is pure JavaScript,
# so no compiler toolchain is required in the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY scripts ./scripts

# Only used when DATABASE_URL is unset (SQLite fallback). On a platform with an ephemeral
# filesystem this directory does not survive a restart - use Postgres there.
RUN mkdir -p data && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run node directly rather than through npm, so SIGTERM reaches the process and the
# shutdown handler in server/index.js can close the database pool cleanly.
CMD ["node", "--env-file-if-exists=.env", "server/index.js"]
