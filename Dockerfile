# Waylo backend — container image for Google Cloud Run.
# Cloud Run sets $PORT (usually 8080); index.js already reads process.env.PORT.
FROM node:20-slim

WORKDIR /app

# Install production dependencies first (better layer caching).
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the source.
COPY . .

ENV NODE_ENV=production
# Cloud Run injects PORT at runtime; this is just documentation.
EXPOSE 8080

CMD ["node", "index.js"]
