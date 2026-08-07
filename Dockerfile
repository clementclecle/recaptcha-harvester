# Playwright's own image ships Chromium plus every system library it needs, and
# runs as the non-root `pwuser` so Chromium's sandbox stays on.
#
# Keep this tag in sync with the playwright version in package.json. The image
# bundles the browser build that exact release expects.
FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3131 \
    # Loopback inside a container is unreachable from a published port, so the
    # image binds all interfaces. Set API_KEY if the port is exposed publicly.
    HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY config.example.yaml ./

USER pwuser
EXPOSE 3131

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3131)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
