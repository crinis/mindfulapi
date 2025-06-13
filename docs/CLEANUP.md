# Cleanup Service

The cleanup service provides automated data retention management for the accessibility scanning application. It removes old scans, their associated issues, and orphaned screenshot files to maintain optimal system performance and storage usage.

## Features

- **Scheduled Cleanup**: Automated cleanup jobs that run on a configurable schedule
- **Configurable Retention**: Set custom retention periods for scan data
- **Screenshot Cleanup**: Automatically removes orphaned screenshot files from the filesystem
- **Database Cascade Deletion**: Properly removes scans and all associated issues
- **Manual Triggers**: API endpoints for administrative control
- **Comprehensive Logging**: Detailed logging for monitoring and debugging

## Configuration

The cleanup service is configured through environment variables:

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLEANUP_ENABLED` | `true` | Enable/disable automatic cleanup |
| `CLEANUP_INTERVAL` | `"0 2 * * *"` | Cron expression for cleanup schedule |
| `CLEANUP_RETENTION_DAYS` | `30` | Days to retain scans before cleanup |
| `SCREENSHOT_DIR` | `./screenshots` | Directory containing screenshot files |
| `CLEANUP_BATCH_SIZE` | `1000` | Batch size for processing operations |
| `CLEANUP_CONCURRENCY_LIMIT` | `10` | Max concurrent file operations |

### Cron Expression Examples

```bash
# Daily at 2:00 AM (default)
CLEANUP_INTERVAL="0 2 * * *"

# Every Sunday at 3:00 AM
CLEANUP_INTERVAL="0 3 * * 0"

# Every 6 hours
CLEANUP_INTERVAL="0 */6 * * *"

# Every hour (for testing)
CLEANUP_INTERVAL="0 * * * *"

# Every 30 minutes (for development)
CLEANUP_INTERVAL="*/30 * * * *"
```

## Scalability Features

The cleanup service is designed to handle large-scale deployments efficiently:

### Database Operations
- **Batched Processing**: Database operations are processed in configurable batches to prevent memory exhaustion
- **Efficient Queries**: Uses count queries and ID-only selections to minimize memory usage
- **Cascade Deletion**: Leverages database foreign key constraints for efficient bulk deletion
- **Progress Logging**: Provides detailed progress information for long-running operations

### File System Operations
- **Streaming Processing**: Files are processed in batches rather than loading all into memory
- **Parallel Deletion**: File removal operations run in parallel with configurable concurrency limits
- **Orphan Detection**: Efficiently identifies files not referenced in the database using batched queries
- **Memory Management**: Processes large directories without excessive memory consumption

### Performance Tuning
- **Configurable Batch Sizes**: Adjust `CLEANUP_BATCH_SIZE` based on available memory and performance requirements
- **Concurrency Control**: Configure `CLEANUP_CONCURRENCY_LIMIT` to optimize for your filesystem and hardware
- **Rate Limiting**: Built-in delays between batches to prevent overwhelming the system
- **Resource Management**: Careful memory and file descriptor management for large datasets

### Scale Testing
The implementation has been designed to handle:
- Millions of files in the screenshot directory
- Hundreds of thousands of scans in the database
- Memory-constrained environments
- High-latency storage systems

## How It Works

The cleanup process operates in two phases with scalability optimizations:

### Phase 1: Database Cleanup
1. Counts scans and issues to be deleted without loading full entities
2. Processes scans in configurable batches to manage memory usage
3. Deletes scan batches with cascade deletion for associated issues
4. Provides progress logging for long-running operations
5. Includes rate limiting between batches to reduce database load

### Phase 2: File System Cleanup
1. Scans the screenshot directory for existing files
2. Processes files in batches with configurable batch size
3. Queries database for referenced files in each batch
4. Identifies orphaned files (exist on disk but not in database)
5. Removes orphaned files in parallel with concurrency control
6. Logs statistics about removed files and processing progress

## API Endpoints

### Manual Cleanup Trigger
```http
POST /admin/cleanup/trigger
Authorization: Bearer YOUR_AUTH_TOKEN
```

Response:
```json
{
  "message": "Cleanup completed successfully"
}
```

### Get Cleanup Configuration
```http
GET /admin/cleanup/config
Authorization: Bearer YOUR_AUTH_TOKEN
```

Response:
```json
{
  "enabled": true,
  "retentionDays": 30,
  "screenshotDir": "/path/to/screenshots",
  "interval": "0 2 * * *",
  "batchSize": 1000,
  "concurrencyLimit": 10
}
```

## Examples

### Basic Configuration
```bash
# Enable cleanup with 30-day retention, running daily at 2 AM
CLEANUP_ENABLED=true
CLEANUP_RETENTION_DAYS=30
CLEANUP_INTERVAL="0 2 * * *"
```

### Development Configuration
```bash
# More frequent cleanup for testing (every hour)
CLEANUP_ENABLED=true
CLEANUP_RETENTION_DAYS=1
CLEANUP_INTERVAL="0 * * * *"
```

### Production Configuration
```bash
# Weekly cleanup with longer retention
CLEANUP_ENABLED=true
CLEANUP_RETENTION_DAYS=90
CLEANUP_INTERVAL="0 3 * * 0"  # Sundays at 3 AM
```

### Disabled Cleanup
```bash
# Disable automatic cleanup (manual only)
CLEANUP_ENABLED=false
```

## Monitoring

The cleanup service provides comprehensive logging:

```
[CleanupService] Cleanup service initialized:
[CleanupService] - Enabled: true
[CleanupService] - Retention period: 30 days
[CleanupService] - Screenshot directory: /app/screenshots
[CleanupService] - Interval: Daily at 2:00 AM

[CleanupService] Starting scheduled cleanup job
[CleanupService] Cleaning up scans older than 2024-12-14T02:00:00.000Z
[CleanupService] Found 15 scans with 145 issues for cleanup
[CleanupService] Database cleanup completed: 15 scans and 145 issues removed
[CleanupService] Found 32 screenshot files referenced in database
[CleanupService] Found 45 screenshot files on disk
[CleanupService] Found 13 orphaned screenshot files
[CleanupService] File cleanup completed: 13 files removed
[CleanupService] Cleanup completed in 1250ms:
[CleanupService] - Scans removed: 15
[CleanupService] - Issues removed: 145
[CleanupService] - Screenshots removed: 13
[CleanupService] - Orphaned files cleaned: 13
[CleanupService] Scheduled cleanup job completed
```

## Security

- All administrative endpoints require authentication via `AUTH_TOKEN`
- The cleanup service only removes data older than the configured retention period
- Manual cleanup triggers bypass the enabled check for emergency situations
- File operations are limited to the configured screenshot directory

## Best Practices

1. **Set Appropriate Retention**: Balance storage costs with data needs
2. **Schedule Off-Peak**: Run cleanup during low-traffic hours (default: 2 AM)
3. **Monitor Logs**: Watch cleanup logs for errors or unexpected behavior
4. **Test Configuration**: Use shorter intervals in development to verify behavior
5. **Backup Strategy**: Ensure backups are taken before cleanup runs
6. **Disk Space Monitoring**: Monitor storage usage to validate cleanup effectiveness

## Troubleshooting

### Cleanup Not Running
- Check `CLEANUP_ENABLED` is set to `true`
- Verify cron expression syntax in `CLEANUP_INTERVAL`
- Check application logs for scheduler errors

### Files Not Being Cleaned
- Verify `SCREENSHOT_DIR` points to the correct directory
- Check file permissions on the screenshot directory
- Review logs for file deletion errors

### Database Cleanup Issues
- Verify database connectivity
- Check for foreign key constraints preventing deletion
- Review scan creation dates vs retention period

### Performance Issues
- Consider adjusting cleanup schedule to off-peak hours
- Monitor cleanup duration in logs
- Implement batch size limits for large datasets if needed
