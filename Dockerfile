# Multi-stage build for optimized production image
FROM node:22-alpine AS builder

# Install system dependencies for native modules
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for building)
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:22-alpine AS production

# tini reaps zombies and forwards signals so graceful shutdown works as PID 1
RUN apk add --no-cache tini

# Set working directory
WORKDIR /app

# Create data directory owned by the unprivileged runtime user
RUN mkdir -p /data && chown node:node /data

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Set application environment variables
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/database.sqlite
ENV PORT=3000

# Expose port
EXPOSE 3000

# Create volumes for persistent data
VOLUME ["/data"]

# Run as the unprivileged node user
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main"]
