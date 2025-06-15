#!/bin/bash

# Database initialization script for production deployments
# This script ensures proper database setup before starting the application
# Environment variables should be set by the deployment environment

set -e

echo "🚀 Starting database initialization..."

# Create necessary directories
echo "📁 Creating necessary directories..."
mkdir -p $(dirname ${DATABASE_PATH:-./data/database.sqlite})
mkdir -p ${SCREENSHOT_DIR:-./data/screenshots}

# Check if database exists and has tables
DB_PATH=${DATABASE_PATH:-./data/database.sqlite}
if [ ! -f "$DB_PATH" ]; then
    echo "📊 Database file does not exist, will be created by migrations"
else
    echo "📊 Database file exists at: $DB_PATH"
fi

# Run migrations
echo "⚡ Running database migrations..."
npm run migration:run

echo "✅ Database initialization completed successfully!"
echo "🎉 Ready to start the application!"
