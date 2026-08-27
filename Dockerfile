# Waylo backend — container image for Google Cloud Run.
# Cloud Run sets $PORT (usually 8080); index.js already reads process.env.PORT.
FROM node:20-slim

WORKDIR /app

# Install production dependencies first (better layer caching).
# Use `npm install` (not `npm ci`): the lockfile is generated on macOS, and
# npm ci is strict about exact platform/lockfile parity — npm install re-resolves
# cleanly for the Linux build image.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy the rest of the source.
COPY . .

ENV NODE_ENV=production
# Cloud Run injects PORT at runtime; this is just documentation.
EXPOSE 8080

CMD ["node", "index.js"]
