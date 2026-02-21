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
RUN mkdir -p /data && chmod 755 /data

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy migration source files
COPY --from=builder /app/src/migrations ./src/migrations
COPY --from=builder /app/src/ormconfig.ts ./src/

# Copy other necessary files
COPY --from=builder /app/nest-cli.json ./

# Set application environment variables
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/database.sqlite
ENV PORT=3000

# Expose port
EXPOSE 3000

# Create volumes for persistent data
VOLUME ["/data"]

CMD ["node", "dist/main"]
