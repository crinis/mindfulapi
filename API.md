# MindfulAPI — API Reference

The interactive Swagger UI (served at `/api` when the server is running) documents every endpoint with live try-out support. This file is the human-readable companion reference.

---

## Base URL

```
http://localhost:3000
```

In production replace `localhost:3000` with your server's address.

---

## Authentication

Authentication is **optional**. When the `AUTH_TOKEN` environment variable is set, every API request must carry a Bearer token in the `Authorization` header:

```http
Authorization: Bearer YOUR_AUTH_TOKEN
```

When `AUTH_TOKEN` is **not set** the API accepts all requests without credentials. This is appropriate for local development or air-gapped internal networks.

> The Swagger UI (`/api`), JSON schema (`/api-json`), and YAML schema (`/api-yaml`) are always publicly accessible — they contain only API metadata, no scan data.

The token comparison uses `crypto.timingSafeEqual` to prevent timing attacks.

---

## Error format

All error responses follow the same shape:

```json
{
  "statusCode": 400,
  "message": ["url must be a URL address"],
  "error": "Bad Request"
}
```

| Field | Type | Description |
|---|---|---|
| `statusCode` | integer | HTTP status code (400–599) |
| `message` | string \| string[] | Human-readable description; an array for validation errors |
| `error` | string | Short reason phrase |

**Common status codes**

| Code | Meaning |
|---|---|
| `400` | Validation failed — check `message` for field-level details |
| `401` | Missing or invalid Bearer token |
| `404` | Resource not found |
| `500` | Unexpected server error |

---

## Scans

Scans are the core resource. A scan run analyzes one or more web pages for accessibility violations using axe-core, and persists the results.

### Scan lifecycle

```
pending → running → completed
                 ↘ failed
```

Scans are processed asynchronously. After calling `POST /scans` the response status will be `pending`. Poll `GET /scans/:id` until `status` is `completed` or `failed`.

### Scan object

All scan endpoints return the same object shape:

| Field | Type | Description |
|---|---|---|
| `id` | integer | Unique scan identifier |
| `mode` | `single_url` \| `url_list` \| `crawl` | How pages were selected |
| `targets` | string[] | Normalized input URLs (single URL, list, or crawl seeds) |
| `status` | string | Current lifecycle status — see [Status values](#status-values) |
| `scanOptions` | object | Effective axe options — see [Scan options](#scan-options) |
| `crawlOptions` | object \| null | Effective crawl config; `null` for non-crawl modes — see [Crawl options](#crawl-options) |
| `progress` | object | Page counts — see [Progress](#progress) |
| `violations` | object[] | Grouped accessibility violations — see [Violations](#violations) |
| `totalIssueCount` | integer | Sum of all issue occurrences across all violations |
| `createdAt` | string (ISO 8601) | When the scan record was created |
| `updatedAt` | string (ISO 8601) | When the scan record was last updated |

#### Scan options

```json
{
  "rootElement": "main",
  "ruleIds": ["color-contrast", "image-alt"]
}
```

| Field | Type | Description |
|---|---|---|
| `rootElement` | string \| null | CSS selector that scoped the scan, or `null` for full-page |
| `ruleIds` | string[] \| null | Axe rule IDs that were run, or `null` meaning all rules |

#### Crawl options

```json
{
  "maxPages": 250,
  "maxDepth": 4,
  "strategy": "same-hostname",
  "globs": [],
  "excludeGlobs": []
}
```

| Field | Type | Description |
|---|---|---|
| `maxPages` | integer | Maximum pages the crawler analyzed |
| `maxDepth` | integer | Maximum link depth from each seed URL |
| `strategy` | string | URL discovery strategy — see [Crawl strategies](#crawl-strategies) |
| `globs` | string[] | Include patterns (empty array = no filter) |
| `excludeGlobs` | string[] | Exclude patterns (empty array = no exclusions) |

#### Progress

```json
{
  "pagesDiscovered": 15,
  "pagesScanned": 14,
  "pagesFailed": 1
}
```

| Field | Type | Description |
|---|---|---|
| `pagesDiscovered` | integer | Total unique pages found for this run |
| `pagesScanned` | integer | Pages successfully analyzed |
| `pagesFailed` | integer | Pages that encountered an error during analysis |

#### Violations

Violations group individual issue occurrences by axe rule and impact level.

```json
[
  {
    "rule": {
      "id": "color-contrast",
      "description": "Elements must have sufficient color contrast",
      "helpUrl": "https://dequeuniversity.com/rules/axe/4.11/color-contrast?application=axeAPI"
    },
    "impact": "serious",
    "issues": [
      {
        "id": 42,
        "pageUrl": "https://example.com/pricing",
        "selector": ".btn-primary",
        "context": "<button class=\"btn-primary\">Buy now</button>"
      }
    ]
  }
]
```

**Rule object**

| Field | Type | Description |
|---|---|---|
| `id` | string | Axe rule identifier (e.g. `color-contrast`) |
| `description` | string | Human-readable rule description |
| `helpUrl` | string \| null | Link to remediation guidance on Deque University |

**Issue object**

| Field | Type | Description |
|---|---|---|
| `id` | integer | Unique issue identifier |
| `pageUrl` | string \| null | Page URL where this occurrence was found |
| `selector` | string \| null | CSS selector identifying the problematic element |
| `context` | string \| null | HTML snippet of the problematic element |

---

### POST /scans

Create a new scan run. The run is queued for asynchronous processing and returns immediately with `status: "pending"`.

**Request body** — `Content-Type: application/json`

The body is a discriminated union on the `mode` field. Three shapes are valid:

#### `single_url` — scan one page

```json
{
  "mode": "single_url",
  "url": "https://example.com",
  "scanOptions": {
    "rootElement": "main",
    "ruleIds": ["color-contrast", "image-alt"],
    "basicAuth": {
      "username": "scanner-user",
      "password": "scanner-password"
    }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `mode` | ✓ | Must be `"single_url"` |
| `url` | ✓ | Absolute HTTP/HTTPS URL to scan |
| `scanOptions` | — | See [scanOptions fields](#scanoptions-fields) |

#### `url_list` — scan an explicit set of pages

```json
{
  "mode": "url_list",
  "urls": [
    "https://example.com",
    "https://example.com/about",
    "https://example.com/pricing"
  ],
  "scanOptions": {
    "ruleIds": ["image-alt"]
  }
}
```

| Field | Required | Constraints | Description |
|---|---|---|---|
| `mode` | ✓ | | Must be `"url_list"` |
| `urls` | ✓ | 2–500 unique URLs | Absolute HTTP/HTTPS URLs to scan |
| `scanOptions` | — | | See [scanOptions fields](#scanoptions-fields) |

#### `crawl` — discover and scan pages automatically

```json
{
  "mode": "crawl",
  "startUrls": ["https://example.com"],
  "scanOptions": {
    "rootElement": "main"
  },
  "crawlOptions": {
    "maxPages": 100,
    "maxDepth": 3,
    "strategy": "same-hostname",
    "globs": ["https://example.com/docs/**"],
    "excludeGlobs": ["**/admin/**"]
  }
}
```

| Field | Required | Constraints | Description |
|---|---|---|---|
| `mode` | ✓ | | Must be `"crawl"` |
| `startUrls` | ✓ | 1–50 unique URLs | Seed URLs for link discovery |
| `scanOptions` | — | | See [scanOptions fields](#scanoptions-fields) |
| `crawlOptions` | — | | See [crawlOptions fields](#crawloptions-fields) |

#### `scanOptions` fields

Applies to all three modes.

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `rootElement` | string | — | min 1 char | CSS selector to restrict the scan to a specific page region. Omit to scan the entire page. |
| `ruleIds` | string[] | — | 1–200 unique IDs | Specific axe rule IDs to run. Omit to run all rules. See `GET /rules` for valid IDs. |
| `basicAuth` | object | — | | HTTP Basic credentials for password-protected pages. Stored encrypted at rest (requires `ENCRYPTION_KEY`); **never returned** in any response. |
| `basicAuth.username` | string | | 1–256 chars | Basic auth username |
| `basicAuth.password` | string | | 1–1024 chars | Basic auth password |

#### `crawlOptions` fields

Only valid when `mode` is `"crawl"`. All fields are optional; defaults apply when omitted.

| Field | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `maxPages` | integer | `250` | 1–5000 | Maximum number of pages the crawler will discover and analyze |
| `maxDepth` | integer | `4` | 0–20 | Maximum number of link hops from each seed URL. `0` means seed pages only. |
| `strategy` | string | `same-hostname` | | URL discovery strategy — see [Crawl strategies](#crawl-strategies) |
| `globs` | string[] | `[]` | 1–20 unique patterns | A discovered URL must match at least one glob to be crawled (e.g. `https://example.com/docs/**`) |
| `excludeGlobs` | string[] | `[]` | 1–20 unique patterns | Discovered URLs matching any pattern are skipped |

**Response — `201 Created`**

Returns the created [scan object](#scan-object). The `Location` header points to the new resource:

```
Location: /scans/42
```

```bash
curl -X POST http://localhost:3000/scans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer changeme" \
  -d '{"mode":"single_url","url":"https://example.com"}'
```

---

### GET /scans

List all scan runs, ordered newest first.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `target` | string (URL) | Filter runs that include this URL as one of their targets. Exact match after URL normalization. |

**Response — `200 OK`** — array of [scan objects](#scan-object)

```bash
# All scans
curl http://localhost:3000/scans -H "Authorization: Bearer changeme"

# Filter by input target URL
curl "http://localhost:3000/scans?target=https://example.com" \
  -H "Authorization: Bearer changeme"
```

---

### GET /scans/:id

Get a single scan run with full violation details.

**Path parameters**

| Parameter | Type | Description |
|---|---|---|
| `id` | integer | Scan ID |

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `pageUrls` | string (repeatable) | Limit returned violations to those containing at least one issue on any of the given page URLs. Violations with no matching issues are omitted entirely. Repeat for multiple values: `?pageUrls=https://a.com&pageUrls=https://b.com` |

**Response — `200 OK`** — [scan object](#scan-object)

```bash
# Full scan with all violations
curl http://localhost:3000/scans/1 -H "Authorization: Bearer changeme"

# Violations from one specific page only
curl "http://localhost:3000/scans/1?pageUrls=https://example.com/pricing" \
  -H "Authorization: Bearer changeme"

# Violations from any of several pages
curl "http://localhost:3000/scans/1?pageUrls=https://example.com/pricing&pageUrls=https://example.com/about" \
  -H "Authorization: Bearer changeme"
```

**Errors** — `404` when no scan exists for the given ID.

---

## Reports

Reports are generated on demand from persisted scan data. Both endpoints require the scan to exist; there is no requirement for it to be `completed`.

### GET /scans/:id/reports/html

Generate and return a self-contained HTML accessibility report.

The HTML document is fully standalone (all styles are inlined) and can be opened directly in a browser or saved as a file.

**Response — `200 OK`**
- `Content-Type: text/html; charset=utf-8`

```bash
curl http://localhost:3000/scans/1/reports/html \
  -H "Authorization: Bearer changeme" \
  -o report.html
```

**Errors** — `404` when the scan does not exist.

---

### GET /scans/:id/reports/pdf

Generate and return a PDF accessibility report.

The PDF is rendered from the same HTML template used by the HTML endpoint, using a headless Chromium browser. This endpoint is slower than the HTML endpoint because it requires browser rendering.

**Response — `200 OK`**
- `Content-Type: application/pdf`
- `Content-Disposition: inline; filename="scan-1-report.pdf"`

```bash
curl http://localhost:3000/scans/1/reports/pdf \
  -H "Authorization: Bearer changeme" \
  -o report.pdf
```

**Errors** — `404` when the scan does not exist.

---

## Rules

### GET /rules

Return all available axe-core accessibility rules, sorted alphabetically by ID.

Use this endpoint to discover valid values for `scanOptions.ruleIds`.

**Response — `200 OK`** — array of rule objects

```json
[
  {
    "id": "color-contrast",
    "description": "Ensure the contrast between foreground and background colors meets WCAG 2 AA minimum contrast ratio thresholds",
    "helpUrl": "https://dequeuniversity.com/rules/axe/4.11/color-contrast?application=axeAPI",
    "tags": ["cat.color", "wcag2aa", "wcag143", "TTv5", "TT13.c", "EN-301-549", "EN-9.1.4.3", "ACT"]
  }
]
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Stable axe rule identifier |
| `description` | string | Human-readable rule description |
| `helpUrl` | string \| null | Link to remediation guidance |
| `tags` | string[] | WCAG and category tags associated with this rule |

```bash
curl http://localhost:3000/rules -H "Authorization: Bearer changeme"
```

---

## Cleanup

Old scan data is deleted automatically according to the `CLEANUP_RETENTION_DAYS` and `CLEANUP_INTERVAL` configuration. These endpoints allow manual control and configuration inspection.

### POST /cleanup

Immediately delete all scans older than the configured retention period. This runs regardless of whether `CLEANUP_ENABLED` is set.

**Response — `200 OK`**

```json
{ "message": "Cleanup completed successfully" }
```

```bash
curl -X POST http://localhost:3000/cleanup -H "Authorization: Bearer changeme"
```

---

### GET /cleanup/config

Return the active cleanup configuration as resolved from environment variables.

**Response — `200 OK`**

```json
{
  "enabled": true,
  "retentionDays": 30,
  "interval": "0 2 * * *"
}
```

| Field | Type | Description |
|---|---|---|
| `enabled` | boolean | Whether the scheduled cleanup job is active |
| `retentionDays` | integer | Scans older than this many days are deleted by the cleanup job |
| `interval` | string | Cron expression controlling the cleanup schedule |

```bash
curl http://localhost:3000/cleanup/config -H "Authorization: Bearer changeme"
```

---

## Type reference

### Status values

| Value | Description |
|---|---|
| `pending` | Queued, waiting to be picked up by a worker |
| `running` | Actively being processed — browser is loading and scanning pages |
| `completed` | All pages processed; results are available |
| `failed` | Scan encountered an unrecoverable error |

### Scan modes

| Value | Description |
|---|---|
| `single_url` | Analyzes exactly one URL |
| `url_list` | Analyzes a fixed list of URLs in parallel |
| `crawl` | Discovers pages by following links from seed URLs, then analyzes them |

### Impact levels

Reported by axe-core for each accessibility violation, from most to least severe:

| Value | Description |
|---|---|
| `critical` | Complete barrier — users relying on assistive technology cannot access the content at all |
| `serious` | Significant difficulty — many users will struggle or be blocked |
| `moderate` | Noticeable difficulty — some users will be impaired |
| `minor` | Minor inconvenience — small improvement opportunity |

### Crawl strategies

Controls which discovered links are followed during a crawl run.

| Value | Description |
|---|---|
| `same-hostname` | Only follow links on the exact same hostname as the seed. `https://docs.example.com` and `https://example.com` are treated as different hosts. **(default)** |
| `same-domain` | Follow links that share the same registered domain. `https://docs.example.com` and `https://example.com` both match a seed of `https://example.com`. |
| `same-origin` | Follow links that share both hostname and protocol. `http://example.com` will not match an `https://example.com` seed. |
| `all` | Follow all discovered links regardless of host or protocol. Use with `globs`/`excludeGlobs` to stay in scope. |
