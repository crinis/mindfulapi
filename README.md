# MindfulAPI

A self-hosted REST API for automated web accessibility scanning, powered by [axe-core](https://github.com/dequelabs/axe-core) and [Playwright](https://playwright.dev/).

MindfulAPI was built to serve as the external accessibility scanner backend for the TYPO3 extension [crinis/mindfula11y](https://github.com/crinis/mindfula11y), but it can be used standalone or integrated with any other client.

## Features

- **Axe-core scanning** — industry-standard accessibility rules mapped to WCAG 2 / Section 508
- **Three scan modes** — scan a single URL, an explicit list of URLs, or crawl a site automatically from seed URLs
- **Asynchronous processing** — scans run in the background via a Redis-backed queue (BullMQ)
- **Scoped scanning** — target a specific CSS selector instead of the whole page
- **Rule filtering** — run only the axe rules you care about
- **Scan history** — results are persisted in SQLite and queryable via the API
- **HTML & PDF reports** — generate accessible, print-ready reports directly from scan results
- **Optional authentication** — protect the API with a Bearer token, or leave it open
- **Automated cleanup** — configurable scheduled deletion of old scan data
- **Flexible browser setup** — runs a local Chromium instance by default; optionally connect to a remote Playwright server via WebSocket

## Requirements

- Docker (to run the full stack with `docker compose`)
- Node.js 22+ (local development only — not required when using Docker)

## Quick Start

### Docker Compose (recommended)

Copy the example environment file and adjust as needed:

```bash
cp .env.example .env
```

Start the stack (API + Redis + Playwright browser):

```bash
docker compose up -d
```

The API will be available at `http://localhost:3000`. The interactive OpenAPI documentation is served at `http://localhost:3000/api`.

> **Auth token:** The compose file defaults to `AUTH_TOKEN=changeme`. Change this before exposing the API publicly:
>
> ```bash
> AUTH_TOKEN=your-secret-token docker compose up -d
> ```

### Local Development

Requires Node.js 22+, Redis, and a local Chromium install.

```bash
# Install dependencies
npm install

# Install Playwright's Chromium browser
npx playwright install chromium

# Start Redis
docker compose -f dev.docker-compose.yml up -d

# Copy env and start the dev server
cp .env.example .env
npm run start:dev
```

## Configuration

All configuration is done via environment variables. Copy `.env.example` for a full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `AUTH_TOKEN` | _(unset)_ | Bearer token for API auth. **When unset, the API is open with no authentication.** |
| `DATABASE_PATH` | `./data/database.sqlite` | SQLite database file path |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | _(unset)_ | Redis password |
| `PLAYWRIGHT_WS_URL` | _(unset)_ | WebSocket URL of a remote Playwright server (e.g. `ws://playwright:3000`). When unset, a local Chromium instance is launched. |
| `IGNORE_HTTPS_ERRORS` | `false` | Ignore TLS errors (useful for self-signed certificates) |
| `CLEANUP_ENABLED` | `true` | Enable scheduled deletion of old scans |
| `CLEANUP_RETENTION_DAYS` | `30` | How many days to keep scans |
| `CLEANUP_INTERVAL` | `0 2 * * *` | Cron schedule for cleanup |
| `CRAWL_CONCURRENCY` | `4` | Maximum pages analyzed in parallel for crawl and url_list modes (clamped to 1–16) |

---

## API Reference

### Authentication

Authentication is optional. When the `AUTH_TOKEN` environment variable is set, all API requests must include a Bearer token:

```http
Authorization: Bearer YOUR_AUTH_TOKEN
```

When `AUTH_TOKEN` is **not set**, the API is open and requires no authentication. This is useful for local development or deployments in trusted internal networks.

> **Security note:** The interactive OpenAPI UI (`/api`), the JSON schema (`/api-json`), and the YAML schema (`/api-yaml`) are always accessible without authentication. They contain only API metadata, not data. If you need to restrict access to these endpoints, place a reverse proxy in front of the API.

The token comparison uses a constant-time algorithm (`crypto.timingSafeEqual`) to prevent timing-based token enumeration attacks.

---

### POST /scans — Create a scan run

Queues a new asynchronous scan run. The request supports three modes through an OpenAPI `oneOf` schema:

- `single_url`: scan exactly one URL
- `url_list`: scan an explicit list of URLs
- `crawl`: crawl from one or more seed URLs and scan discovered pages

**Request body — `single_url`**

```json
{
  "mode": "single_url",
  "url": "https://example.com",
  "scanOptions": {
    "rootElement": "main",
    "ruleIds": ["color-contrast", "image-alt"]
  }
}
```

**Request body — `url_list`**

```json
{
  "mode": "url_list",
  "urls": ["https://example.com", "https://example.com/about"]
}
```

**Request body — `crawl`**

```json
{
  "mode": "crawl",
  "startUrls": ["https://example.com"],
  "crawlOptions": {
    "maxPages": 250,
    "maxDepth": 4,
    "strategy": "same-hostname",
    "globs": ["https://example.com/docs/**"],
    "excludeGlobs": ["**/admin/**"]
  }
}
```

**`crawlOptions` fields**

| Field | Default | Description |
|-------|---------|-------------|
| `maxPages` | `250` | Maximum number of pages to scan |
| `maxDepth` | `4` | Maximum link-follow depth from seed URLs |
| `strategy` | `same-hostname` | Crawlee enqueue strategy: `all`, `same-hostname`, `same-domain`, `same-origin` |
| `globs` | `[]` | Crawlee glob patterns — only URLs matching at least one glob are enqueued (e.g. `https://example.com/docs/**`) |
| `excludeGlobs` | `[]` | Crawlee glob patterns — matching URLs are never enqueued |

**Response — `201 Created`**

```json
{
  "id": 1,
  "mode": "single_url",
  "targets": ["https://example.com/"],
  "status": "pending",
  "scanOptions": {
    "rootElement": "main",
    "ruleIds": ["color-contrast", "image-alt"]
  },
  "crawlOptions": null,
  "progress": {
    "pagesDiscovered": 0,
    "pagesScanned": 0,
    "pagesFailed": 0
  },
  "violations": [],
  "totalIssueCount": 0,
  "createdAt": "2025-06-14T10:30:00.000Z",
  "updatedAt": "2025-06-14T10:30:00.000Z"
}
```

```bash
curl -X POST http://localhost:3000/scans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer changeme" \
  -d '{"mode":"single_url","url":"https://example.com"}'
```

---

### GET /scans — List scan runs

Returns all scan runs ordered by creation date (newest first). Use the optional `target` query parameter to filter results by one input target URL.

```bash
# All scans
curl http://localhost:3000/scans -H "Authorization: Bearer changeme"

# Filter by target
curl "http://localhost:3000/scans?target=https://example.com" \
  -H "Authorization: Bearer changeme"
```

---

### GET /scans/:id — Get scan by ID

Returns a specific scan with full violation details.

**Query parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `pageUrl` | `string` (repeatable) | Filter violations to those containing at least one issue on any of the given page URLs. Repeat the parameter for multiple values. Omitting it returns all violations. |

```bash
# All violations
curl http://localhost:3000/scans/1 -H "Authorization: Bearer changeme"

# Violations from one specific page
curl "http://localhost:3000/scans/1?pageUrl=https://example.com/pricing" \
  -H "Authorization: Bearer changeme"

# Violations from any of several pages
curl "http://localhost:3000/scans/1?pageUrl=https://example.com/pricing&pageUrl=https://example.com/about" \
  -H "Authorization: Bearer changeme"
```

**Response — `200 OK` (completed scan)**

```json
{
  "id": 1,
  "mode": "crawl",
  "targets": ["https://example.com/"],
  "status": "completed",
  "scanOptions": {
    "rootElement": null,
    "ruleIds": null
  },
  "crawlOptions": {
    "maxPages": 250,
    "maxDepth": 4,
    "strategy": "same-hostname",
    "globs": [],
    "excludeGlobs": []
  },
  "progress": {
    "pagesDiscovered": 15,
    "pagesScanned": 15,
    "pagesFailed": 0
  },
  "violations": [
    {
      "rule": {
        "id": "color-contrast",
        "description": "Elements must have sufficient color contrast",
        "helpUrl": "https://dequeuniversity.com/rules/axe/4.11/color-contrast?application=axeAPI"
      },
      "impact": "serious",
      "issues": [
        {
          "id": 1,
          "pageUrl": "https://example.com/pricing",
          "selector": ".btn-primary",
          "context": "<button class=\"btn-primary\">Submit</button>"
        }
      ]
    }
  ],
  "totalIssueCount": 2,
  "createdAt": "2025-06-14T10:30:00.000Z",
  "updatedAt": "2025-06-14T10:31:00.000Z"
}
```

---

### GET /scans/:id/reports/html — Get HTML report

Generates and returns a complete, self-contained HTML accessibility report for a scan. The report includes a summary, scan targets, violation details grouped by rule and impact level, and issue tables with page URL, CSS selector, and HTML context. The HTML is accessible and renders correctly in a browser or can be saved as a file.

```bash
curl http://localhost:3000/scans/1/reports/html \
  -H "Authorization: Bearer changeme" \
  -o report.html
```

**Response — `200 OK`**: `Content-Type: text/html; charset=utf-8`

---

### GET /scans/:id/reports/pdf — Get PDF report

Generates and returns a PDF accessibility report for a scan. The PDF is rendered from the same HTML template used by the HTML report endpoint using a headless Chromium browser.

```bash
curl http://localhost:3000/scans/1/reports/pdf \
  -H "Authorization: Bearer changeme" \
  -o report.pdf
```

**Response — `200 OK`**: `Content-Type: application/pdf`, `Content-Disposition: inline; filename="scan-1-report.pdf"`

---

### GET /rules — List axe rules

Returns all available axe-core accessibility rules with metadata, sorted alphabetically.

```bash
curl http://localhost:3000/rules -H "Authorization: Bearer changeme"
```

**Response — `200 OK`**

```json
[
  {
    "id": "color-contrast",
    "description": "Ensure the contrast between foreground and background colors meets WCAG 2 AA minimum contrast ratio thresholds",
    "helpUrl": "https://dequeuniversity.com/rules/axe/4.11/color-contrast?application=axeAPI",
    "tags": ["cat.color", "wcag2aa", "wcag143", "TTv5", "TT13.c", "EN-301-549", "EN-9.1.4.3", "ACT", "RGAAv4", "RGAA-3.2.1"]
  }
]
```

---

### POST /cleanup — Trigger manual cleanup

Immediately deletes scans older than the configured retention period, bypassing the `CLEANUP_ENABLED` flag.

```bash
curl -X POST http://localhost:3000/cleanup -H "Authorization: Bearer changeme"
```

**Response — `200 OK`**

```json
{ "message": "Cleanup completed successfully" }
```

---

### GET /cleanup/config — Get cleanup configuration

Returns the active cleanup configuration derived from environment variables.

```bash
curl http://localhost:3000/cleanup/config -H "Authorization: Bearer changeme"
```

**Response — `200 OK`**

```json
{
  "enabled": true,
  "retentionDays": 30,
  "interval": "0 2 * * *"
}
```

---

### Scan status values

| Status | Description |
|--------|-------------|
| `pending` | Queued, not yet started |
| `running` | Actively scanning |
| `completed` | Finished successfully |
| `failed` | Scan encountered an error |

### Impact levels

| Level | Description |
|-------|-------------|
| `critical` | Causes complete barriers for assistive technology users |
| `serious` | Causes significant difficulties for some users |
| `moderate` | Causes some difficulties; lower priority |
| `minor` | Minor inconvenience |

---

## Use with mindfula11y (TYPO3)

MindfulAPI is designed to integrate with the [mindfula11y](https://github.com/crinis/mindfula11y) TYPO3 extension as an external accessibility scanner backend. The TYPO3 extension sends scan requests to this API and displays the results directly in the TYPO3 backend, enabling editors and integrators to review and fix accessibility issues without leaving the CMS.

Deploy MindfulAPI on the same server as your TYPO3 installation or in your existing Docker/Kubernetes infrastructure, then configure the extension to point to the API's base URL and auth token.

## Architecture

```
Client (TYPO3 / curl / etc.)
        │  POST /scans
        ▼
   NestJS API  ──► SQLite (scan metadata + results)
        │
        ▼
   BullMQ Queue (Redis)
        │
        ▼
   Scan Processor
        │
        ▼
   Playwright + axe-core  ──► target URL
```

## License

[MIT](LICENSE)
