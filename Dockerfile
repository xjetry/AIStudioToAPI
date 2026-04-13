# Single-stage build with Node.js 24
FROM node:24-slim

WORKDIR /app

# Install system dependencies required for Camoufox/Chromium browsers (Playwright runtime libs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Copy package manifests and install all dependencies (including dev for build tools)
# Layer is cached unless package.json changes.
#
# --ignore-scripts prevents Playwright/Patchright/camoufox-js postinstalls from
# auto-downloading browser binaries during npm install — we do those in explicit
# later layers for better cache granularity. But we MUST rebuild better-sqlite3
# (a transitive dep of camoufox-js) because its install script uses prebuild-install
# to fetch a native .node binding that is otherwise missing.
COPY package*.json ./
RUN npm install --no-audit --no-fund --ignore-scripts \
    && npm rebuild better-sqlite3 \
    && npm cache clean --force

# Download Camoufox browser via camoufox-js (managed binary + GeoIP database)
# Cached under /root/.cache/camoufox/ (Linux default for XDG_CACHE_HOME). Used by
# BrowserManager as the main kernel for API proxying.
RUN npx camoufox-js fetch

# Download Patchright Chromium binary. Only used by ScreencastAuth for the temporary
# login browser (separate from the main Camoufox kernel). Needed at runtime when a user
# initiates web-UI-based Google login via the /auth page.
RUN npx patchright install chromium

# Copy application source code with proper ownership
# Layer is rebuilt when source code changes
COPY --chown=node:node main.js ./
COPY --chown=node:node vite.config.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node configs ./configs
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node ui ./ui

# Build frontend assets with Vite
# VERSION is passed from docker build-args for version display in UI
ARG VERSION
RUN VERSION=${VERSION} npm run build:ui

# Remove dev dependencies after build to reduce image size
RUN npm prune --omit=dev && npm cache clean --force

# TODO: Temporarily use the root user, and in the future we will switch to the node user
USER root

# Expose application ports
EXPOSE 7860

# Configure runtime environment
# Note: Do NOT set CAMOUFOX_EXECUTABLE_PATH or BROWSER_EXECUTABLE_PATH — camoufox-js
# manages its own binary under ~/.cache/camoufox/ (downloaded via `npx camoufox-js fetch`
# in the image). Setting an explicit path would require properties.json to sit next to
# the binary, which the managed layout handles automatically.
ENV NODE_ENV=production

# Health check for container orchestration platforms
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "const port = process.env.PORT || 7860; require('http').get('http://localhost:' + port + '/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}).on('error', () => process.exit(1));" || exit 1

# Start the application server
CMD ["node", "main.js"]
