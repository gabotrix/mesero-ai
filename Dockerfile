# The backend, for a host with a public name and a certificate.
#
# At the repository root on purpose: platforms find it here without being told,
# and `docker build .` works with no arguments. Railway was ignoring a pointer
# to it elsewhere and falling back to its own language detector, which cannot
# make sense of a repository holding firmware, CAD and a backend at once.
#
# This is the shape that matters: a diner is on their own mobile data, not the
# restaurant's WiFi, so the table screen has to be reachable from the internet.
# A machine behind the bar cannot be, without a tunnel and a firewall argument.
FROM node:20-alpine

WORKDIR /app

# Dependencies first, so a menu edit does not reinstall the world.
COPY backend/package*.json ./backend/
RUN npm --prefix ./backend ci --omit=dev

COPY backend ./backend
COPY web ./web

ENV NODE_ENV=production
ENV MESERO_ROOT=/app
ENV PORT=8787
EXPOSE 8787

# The carta pulled from the platform is cached back to backend/menu.json, so the
# app has to own what it was given — files copied in are root's otherwise, and
# the container died on boot unable to write its own cache.
RUN chown -R node:node /app

# Not root: this process holds no secrets worth having, but it does hold an open
# socket to the internet.
USER node

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8787}/api/health" || exit 1

CMD ["node", "backend/src/index.js"]
