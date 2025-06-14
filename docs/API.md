# API Documentation

This document provides comprehensive documentation for all REST API endpoints in the Accessibility Scanning Service.

## Base URL

```
http://localhost:3000  # Development
https://your-api-domain.com  # Production
```

## Authentication

All API endpoints require authentication using Bearer tokens:

```http
Authorization: Bearer YOUR_AUTH_TOKEN
```

Set your authentication token in the environment variable `AUTH_TOKEN`. In development, the default token is `changeme`.

---

# Scan Management Endpoints

The scan management endpoints handle the creation, retrieval, and lifecycle management of accessibility scans.

## Create New Scan

**POST** `/scans`

Creates a new accessibility scan and queues it for asynchronous processing.

### Request Body

```json
{
  "url": "https://example.com",
  "language": "en",
  "rootElement": "main"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | Target URL to scan. Supports HTTP and HTTPS protocols. TLD not required for localhost/development. |
| `language` | string | No | Language preference for accessibility rule descriptions. Defaults to "en" if not specified. |
| `rootElement` | string | No | CSS selector to limit scanning scope to a specific page element. If not specified, the entire page will be scanned. |
| `scannerType` | string | No | Accessibility scanner type to use ('htmlcs' or 'axe'). Defaults to "htmlcs" if not specified. |
| `ruleIds` | array[string] | No | Specific accessibility rule IDs to execute during scanning. Only the specified rules will be run and their results stored. If not specified, all available rules for the scanner will be executed. |

### Response

**Status:** `201 Created`

```json
{
  "id": 1,
  "url": "https://example.com",
  "language": "en",
  "rootElement": "main",
  "scannerType": "htmlcs",
  "status": "pending",
  "violations": [],
  "totalIssueCount": 0,
  "createdAt": "2025-06-14T10:30:00.000Z",
  "updatedAt": "2025-06-14T10:30:00.000Z"
}
```

### Example Usage

**Basic scan:**
```bash
curl -X POST http://localhost:3000/scans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer changeme" \
  -d '{
    "url": "https://example.com"
  }'
```

**Scan with language specified:**
```bash
curl -X POST http://localhost:3000/scans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer changeme" \
  -d '{
    "url": "https://example.com",
    "language": "es"
  }'
```

**Scan with Axe scanner:**
```bash
curl -X POST http://localhost:3000/scans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer changeme" \
  -d '{
    "url": "https://example.com",
    "scannerType": "axe"
  }'
```

**Scan with limited scope:**
```bash
curl -X POST http://localhost:3000/scans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer changeme" \
  -d '{
    "url": "https://example.com",
    "language": "en",
    "rootElement": "main"
  }'
```

**Scan with specific Axe rules:**
```bash
curl -X POST http://localhost:3000/scans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer changeme" \
  -d '{
    "url": "https://example.com",
    "scannerType": "axe",
    "ruleIds": ["color-contrast", "alt-text", "link-name"]
  }'
```

**Scan with specific HTMLCS rules:**
```bash
curl -X POST http://localhost:3000/scans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer changeme" \
  -d '{
    "url": "https://example.com",
    "scannerType": "htmlcs",
    "ruleIds": ["WCAG2AA.Principle1.Guideline1_1.1_1_1.H37", "WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.A.Empty"]
  }'
```

**Comprehensive scan with all options:**
```bash
curl -X POST http://localhost:3000/scans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer changeme" \
  -d '{
    "url": "https://example.com",
    "language": "es",
    "rootElement": "main",
    "scannerType": "axe",
    "ruleIds": ["color-contrast", "alt-text"]
  }'
```

---

## List All Scans

**GET** `/scans`

Retrieves all accessibility scans ordered by creation date (newest first).

### Response

**Status:** `200 OK`

```json
[
  {
    "id": 2,
    "url": "https://example.com",
    "language": "en",
    "scannerType": "htmlcs",
    "status": "completed",
    "violations": [
      {
        "rule": {
          "id": "WCAG2AA.Principle1.Guideline1_1.1_1_1.H37",
          "description": "Img element missing an alt attribute",
          "impact": "error",
          "urls": [
            "https://www.w3.org/WAI/WCAG21/Techniques/html/H37"
          ]
        },
        "issueCount": 3,
        "issues": [
          {
            "id": 1,
            "selector": "img:nth-child(1)",
            "context": "<img src=\"logo.png\">",
            "screenshotUrl": "http://localhost:3000/screenshots/issue-1-screenshot.png"
          }
        ]
      }
    ],
    "totalIssueCount": 3,
    "createdAt": "2025-06-14T10:30:00.000Z",
    "updatedAt": "2025-06-14T10:35:00.000Z"
  }
]
```

### Example Usage

```bash
curl -X GET http://localhost:3000/scans \
  -H "Authorization: Bearer changeme"
```

---

## Get Scan by ID

**GET** `/scans/{id}`

Retrieves a specific scan by its unique identifier with complete violation details.

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | integer | Unique scan identifier |

### Response

**Status:** `200 OK`

```json
{
  "id": 1,
  "url": "https://example.com",
  "language": "en",
  "scannerType": "htmlcs",
  "status": "completed",
  "violations": [
    {
      "rule": {
        "id": "WCAG2AA.Principle1.Guideline1_1.1_1_1.H37",
        "description": "Img element missing an alt attribute",
        "impact": "error",
        "urls": [
          "https://www.w3.org/WAI/WCAG21/Techniques/html/H37"
        ]
      },
      "issueCount": 2,
      "issues": [
        {
          "id": 1,
          "selector": "img:nth-child(1)",
          "context": "<img src=\"logo.png\">",
          "screenshotUrl": "http://localhost:3000/screenshots/issue-1-screenshot.png"
        },
        {
          "id": 2,
          "selector": "img:nth-child(3)",
          "context": "<img src=\"banner.jpg\">",
          "screenshotUrl": "http://localhost:3000/screenshots/issue-2-screenshot.png"
        }
      ]
    }
  ],
  "totalIssueCount": 2,
  "createdAt": "2025-06-14T10:30:00.000Z",
  "updatedAt": "2025-06-14T10:35:00.000Z"
}
```

**Status:** `404 Not Found`

```json
{
  "message": "Scan with ID 999 not found",
  "error": "Not Found",
  "statusCode": 404
}
```

### Example Usage

```bash
curl -X GET http://localhost:3000/scans/1 \
  -H "Authorization: Bearer changeme"
```

---

## Get Scans by URL

**GET** `/scans/by-url`

Retrieves all scans for a specific URL, useful for tracking scan history over time.

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | Target URL to retrieve scan history for |

### Response

**Status:** `200 OK`

Returns an array of scans for the specified URL, ordered by creation date (newest first).

```json
[
  {
    "id": 3,
    "url": "https://example.com",
    "language": "en",
    "scannerType": "htmlcs",
    "status": "completed",
    "violations": [...],
    "totalIssueCount": 5,
    "createdAt": "2025-06-14T12:00:00.000Z",
    "updatedAt": "2025-06-14T12:05:00.000Z"
  },
  {
    "id": 1,
    "url": "https://example.com",
    "language": "en",
    "scannerType": "htmlcs",
    "status": "completed",
    "violations": [...],
    "totalIssueCount": 8,
    "createdAt": "2025-06-14T10:30:00.000Z",
    "updatedAt": "2025-06-14T10:35:00.000Z"
  }
]
```

### Example Usage

```bash
curl -X GET "http://localhost:3000/scans/by-url?url=https://example.com" \
  -H "Authorization: Bearer changeme"
```

---

# Administrative Endpoints

Administrative endpoints provide system management capabilities for the cleanup service and application configuration.

## Trigger Manual Cleanup

**POST** `/admin/cleanup/trigger`

Manually triggers the cleanup process to remove old scans and associated data.

### Response

**Status:** `200 OK`

```json
{
  "message": "Cleanup completed successfully"
}
```

### Example Usage

```bash
curl -X POST http://localhost:3000/admin/cleanup/trigger \
  -H "Authorization: Bearer changeme"
```

### Notes

- This endpoint bypasses the `CLEANUP_ENABLED` setting for emergency cleanup
- Cleanup removes scans older than the configured retention period
- Associated issues and screenshot files are automatically cleaned up
- Operation is logged for monitoring purposes

---

## Get Cleanup Configuration

**GET** `/admin/cleanup/config`

Retrieves the current cleanup service configuration.

### Response

**Status:** `200 OK`

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

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Whether automatic cleanup is enabled |
| `retentionDays` | number | Number of days to retain scan data |
| `screenshotDir` | string | Directory where screenshot files are stored |
| `interval` | string | Cron expression for cleanup schedule |
| `batchSize` | number | Number of records processed per batch |
| `concurrencyLimit` | number | Maximum concurrent file operations |

### Example Usage

```bash
curl -X GET http://localhost:3000/admin/cleanup/config \
  -H "Authorization: Bearer changeme"
```

---

# Rules Discovery Endpoints

The rules discovery endpoints allow clients to retrieve information about available accessibility rules for different scanner types.

## Get Rules for Scanner Type

**GET** `/rules`

Retrieves all available accessibility rules for a specific scanner type with optional language preferences.

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `scannerType` | string | No | Scanner type to retrieve rules for ('htmlcs' or 'axe'). Defaults to 'htmlcs' if not specified. |
| `language` | string | No | Language preference for rule descriptions. Defaults to "en" if not specified. |

### Response

**Status:** `200 OK`

```json
[
  {
    "id": "color-contrast",
    "description": "Ensures the contrast between foreground and background colors meets WCAG AA standard",
    "impact": "error",
    "urls": ["https://dequeuniversity.com/rules/axe/4.6/color-contrast"]
  },
  {
    "id": "alt-text",
    "description": "Ensures img elements have alternate text or a role of none or presentation",
    "impact": "error", 
    "urls": ["https://dequeuniversity.com/rules/axe/4.6/alt-text"]
  }
]
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier for the accessibility rule |
| `description` | string | Human-readable description of what the rule checks |
| `impact` | string | Severity level: "error", "warning", or "notice" |
| `urls` | array | Array of help URLs providing remediation guidance |

### Example Usage

**Get default HTMLCS rules in English:**
```bash
curl -X GET "http://localhost:3000/rules" \
  -H "Authorization: Bearer changeme"
```

**Get Axe rules in English:**
```bash
curl -X GET "http://localhost:3000/rules?scannerType=axe" \
  -H "Authorization: Bearer changeme"
```

**Get HTMLCS rules in Spanish:**
```bash
curl -X GET "http://localhost:3000/rules?scannerType=htmlcs&language=es" \
  -H "Authorization: Bearer changeme"
```

**Get Axe rules in French:**
```bash
curl -X GET "http://localhost:3000/rules?scannerType=axe&language=fr" \
  -H "Authorization: Bearer changeme"
```

### Scanner Types

| Scanner | Description | Rule Count (Approx) | Help URL Pattern |
|---------|-------------|---------------------|------------------|
| `htmlcs` | HTML_CodeSniffer accessibility scanner | ~231 rules | W3C WCAG Techniques |
| `axe` | Axe accessibility scanner | ~96 rules | Deque University |

### Supported Languages

The API supports the following language codes for rule descriptions:

| Code | Language | Code | Language |
|------|----------|------|----------|
| `en` | English (default) | `es` | Spanish |
| `fr` | French | `it` | Italian |
| `de` | German | `nl` | Dutch |
| `ar` | Arabic | `ja` | Japanese |
| `ko` | Korean | `pl` | Polish |
| `zh_CN` | Chinese (Simplified) | `zh_TW` | Chinese (Traditional) |
| `da` | Danish | `eu` | Basque |
| `he` | Hebrew | `no_NB` | Norwegian (Bokmål) |
| `pt_BR` | Portuguese (Brazil) | | |

### Error Responses

**Status:** `400 Bad Request`

```json
{
  "message": ["scannerType must be one of the following values: htmlcs, axe"],
  "error": "Bad Request",
  "statusCode": 400
}
```

**Status:** `401 Unauthorized`

```json
{
  "message": "Invalid or missing authentication token",
  "error": "Unauthorized",
  "statusCode": 401
}
```

---

# Data Models

## Scan Status

Possible values for scan status:

| Status | Description |
|--------|-------------|
| `pending` | Scan has been created and queued for processing |
| `running` | Scan is currently being processed |
| `completed` | Scan has finished successfully |
| `failed` | Scan encountered an error during processing |

## Issue Impact Levels

Accessibility issues are categorized by impact level:

| Impact | Description |
|--------|-------------|
| `error` | Must fix - prevents accessibility (WCAG violations) |
| `warning` | Should investigate - potential accessibility barrier |
| `notice` | Consider addressing - accessibility best practice |

## Scanner Types

The API supports two accessibility scanning engines:

| Scanner | Description | Strengths | Rule Count |
|---------|-------------|-----------|------------|
| `htmlcs` | HTML_CodeSniffer accessibility scanner (default) | Comprehensive WCAG coverage, detailed technique guidance | ~231 rules |
| `axe` | Axe accessibility scanner | Fast, accurate, industry standard | ~96 rules |

### Scanner Differences

- **HTMLCS**: Provides extensive WCAG technique URLs from W3.org, ideal for learning and compliance
- **Axe**: Offers focused, actionable rules with Deque University documentation, preferred for speed and accuracy
- **Help URLs**: HTMLCS uses W3C WCAG technique URLs, Axe uses Deque University documentation
- **Rule Coverage**: HTMLCS has broader rule coverage, Axe focuses on high-confidence violations

## Rule Response Structure

Rule information for accessibility violations:

```json
{
  "id": "WCAG2AA.Principle1.Guideline1_1.1_1_1.H37",
  "description": "Human-readable description of the rule violation",
  "impact": "error",
  "urls": ["https://www.w3.org/WAI/WCAG21/Techniques/html/H37"]
}
```

## Violation Response Structure

Each violation groups issues by accessibility rule:

```json
{
  "rule": {
    "id": "WCAG2AA.Principle1.Guideline1_1.1_1_1.H37",
    "description": "Human-readable description of the rule violation",
    "impact": "error",
    "urls": ["https://www.w3.org/WAI/WCAG21/Techniques/html/H37"]
  },
  "issueCount": 3,
  "issues": [
    {
      "id": 1,
      "selector": "img:nth-child(1)",
      "context": "<img src=\"logo.png\">",
      "screenshotUrl": "http://localhost:3000/screenshots/issue-1.png"
    }
  ]
}
```

## Issue Response Structure

Individual issues within a violation:

```json
{
  "id": 1,
  "selector": "img:nth-child(1)",
  "context": "<img src=\"logo.png\">",
  "screenshotUrl": "http://localhost:3000/screenshots/issue-1.png"
}
```

## Scan Response Structure

Complete scan response with all metadata fields:

```json
{
  "id": 1,
  "url": "https://example.com",
  "language": "en",
  "rootElement": "main",
  "scannerType": "htmlcs",
  "status": "completed",
  "violations": [
    {
      "rule": {
        "id": "WCAG2AA.Principle1.Guideline1_1.1_1_1.H37",
        "description": "Img element missing an alt attribute",
        "impact": "error",
        "urls": ["https://www.w3.org/WAI/WCAG21/Techniques/html/H37"]
      },
      "issueCount": 2,
      "issues": [...]
    }
  ],
  "totalIssueCount": 2,
  "createdAt": "2025-06-14T10:30:00.000Z",
  "updatedAt": "2025-06-14T10:35:00.000Z"
}
```

### Scan Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Unique scan identifier |
| `url` | string | Target URL that was scanned |
| `language` | string | Language preference used for rule descriptions |
| `rootElement` | string (optional) | CSS selector used to limit scan scope |
| `scannerType` | string | Scanner type used: "htmlcs" or "axe" |
| `status` | string | Current scan status: "pending", "running", "completed", or "failed" |
| `violations` | array | Array of grouped accessibility violations |
| `totalIssueCount` | number | Total number of accessibility issues found |
| `createdAt` | string (ISO 8601) | Timestamp when scan was created |
| `updatedAt` | string (ISO 8601) | Timestamp when scan was last updated |

---

# Error Responses

## Standard Error Format

```json
{
  "message": "Error description",
  "error": "Error Type",
  "statusCode": 400
}
```

## Common HTTP Status Codes

| Code | Description | When It Occurs |
|------|-------------|----------------|
| `200` | OK | Successful GET requests |
| `201` | Created | Successful POST requests (scan creation) |
| `400` | Bad Request | Invalid request parameters or body |
| `401` | Unauthorized | Missing or invalid authentication token |
| `404` | Not Found | Requested resource doesn't exist |
| `500` | Internal Server Error | Unexpected server error |

---

# Rate Limiting and Performance

## Scan Processing

- Scans are processed asynchronously in background queues
- Multiple scans can be created simultaneously
- Processing time depends on page complexity and number of issues
- Status can be monitored by polling the scan endpoint

## Screenshot URLs

- Screenshot URLs are automatically generated based on request context
- URLs include the full base URL for easy client consumption
- Screenshots are only available for completed scans with visual issues
- File cleanup is handled automatically by the cleanup service

## Best Practices

1. **Polling**: Check scan status periodically rather than continuously
2. **Batch Requests**: Use the list endpoints to retrieve multiple scans efficiently
3. **Error Handling**: Always handle 404 responses for scan retrieval
4. **Authentication**: Store and manage API tokens securely
5. **URL Encoding**: Properly encode URLs in query parameters

---

# Examples and Use Cases

## Basic Workflow

1. **Create Scan**: POST to `/scans` with target URL
2. **Monitor Progress**: GET `/scans/{id}` to check status
3. **Retrieve Results**: Once completed, parse violations array
4. **Track History**: Use `/scans/by-url` for historical analysis

## Rules Discovery Workflow

1. **Discover Available Rules**: GET `/rules?scannerType=axe` to see all available rules
2. **Compare Scanner Types**: Check rule differences between HTMLCS and Axe
3. **Multilingual Support**: Use `language` parameter for localized rule descriptions
4. **Build Interfaces**: Use rule metadata to create filtering and reporting tools

## Monitoring and Maintenance

1. **Check Configuration**: GET `/admin/cleanup/config`
2. **Manual Cleanup**: POST `/admin/cleanup/trigger` when needed
3. **System Health**: Monitor error rates and response times

## Integration Examples

### JavaScript/Node.js

```javascript
const API_BASE = 'http://localhost:3000';
const AUTH_TOKEN = 'changeme';

// Create a new scan
const createScan = async (url, scannerType = 'htmlcs') => {
  const response = await fetch(`${API_BASE}/scans`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AUTH_TOKEN}`
    },
    body: JSON.stringify({ url, language: 'en', scannerType })
  });
  return response.json();
};

// Get available rules for a scanner
const getRules = async (scannerType, language = 'en') => {
  const response = await fetch(`${API_BASE}/rules?scannerType=${scannerType}&language=${language}`, {
    headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
  });
  return response.json();
};

// Poll for scan completion
const waitForScan = async (scanId) => {
  let scan;
  do {
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    const response = await fetch(`${API_BASE}/scans/${scanId}`, {
      headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
    });
    scan = await response.json();
  } while (scan.status === 'pending' || scan.status === 'running');
  
  return scan;
};
```

### Python

```python
import requests
import time

API_BASE = 'http://localhost:3000'
AUTH_TOKEN = 'changeme'
HEADERS = {'Authorization': f'Bearer {AUTH_TOKEN}'}

def create_scan(url, scanner_type='htmlcs'):
    response = requests.post(
        f'{API_BASE}/scans',
        json={'url': url, 'language': 'en', 'scannerType': scanner_type},
        headers={**HEADERS, 'Content-Type': 'application/json'}
    )
    return response.json()

def get_rules(scanner_type, language='en'):
    response = requests.get(
        f'{API_BASE}/rules?scannerType={scanner_type}&language={language}',
        headers=HEADERS
    )
    return response.json()

def wait_for_scan(scan_id):
    while True:
        response = requests.get(f'{API_BASE}/scans/{scan_id}', headers=HEADERS)
        scan = response.json()
        if scan['status'] in ['completed', 'failed']:
            return scan
        time.sleep(2)
```

---


This API documentation covers all available endpoints and provides comprehensive examples for integration. For additional support or feature requests, please refer to the project documentation or contact the development team.
