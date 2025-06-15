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

# Set working directory
WORKDIR /app

# Create data directory and set permissions
RUN mkdir -p /data/screenshots && chmod 755 /data

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy migration source files (for development/manual operations if needed)
COPY --from=builder /app/src/migrations ./src/migrations
COPY --from=builder /app/src/ormconfig.ts ./src/

# Copy other necessary files
COPY --from=builder /app/nest-cli.json ./

# Set application environment variables
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/database.sqlite
ENV SCREENSHOT_DIR=/data/screenshots
ENV PORT=3000

# Expose port
EXPOSE 3000

# Create volumes for persistent data
VOLUME ["/data"]

# Create a simple startup script that ensures directories exist
RUN echo '#!/bin/sh' > /app/startup.sh && \
    echo 'echo "🚀 Starting MindfulAPI..."' >> /app/startup.sh && \
    echo 'mkdir -p /data/screenshots' >> /app/startup.sh && \
    echo 'echo "📁 Data directories created"' >> /app/startup.sh && \
    echo 'echo "🎉 Starting application (migrations will run automatically)..."' >> /app/startup.sh && \
    echo 'exec node dist/main' >> /app/startup.sh && \
    chmod +x /app/startup.sh

# Start the application with automatic migration
CMD ["/app/startup.sh"]
