# MindfulAPI

A self-hosted REST API for automated web accessibility scanning, powered by [axe-core](https://github.com/dequelabs/axe-core) and [Playwright](https://playwright.dev/).

MindfulAPI was built to serve as the external accessibility scanner backend for the TYPO3 extension [crinis/mindfula11y](https://github.com/crinis/mindfula11y), but it can be used standalone or integrated with any other client.

> **Disclaimer**
> - Significant parts of this application were generated or refined with the help of AI tools.
> - Run MindfulAPI only in a secure environment and apply proper hardening before exposing it publicly.

## Features

- **Axe-core scanning** — industry-standard accessibility rules mapped to WCAG 2 / Section 508
- **Three scan modes** — scan a single URL, an explicit list of URLs, or crawl a site automatically from seed URLs
- **Asynchronous processing** — scans run in the background via a Redis-backed queue (BullMQ)
- **Scoped scanning** — target a specific CSS selector instead of the whole page
- **Rule filtering** — run only the axe rules you care about
- **Basic auth support** — optionally provide per-scan HTTP Basic credentials for protected targets
- **Scan history** — results are persisted in SQLite and queryable via the API
- **HTML & PDF reports** — generate accessible, print-ready reports directly from scan results
- **Optional authentication** — protect the API with a Bearer token, or leave it open
- **Automated cleanup** — configurable scheduled deletion of old scan data
- **Flexible browser setup** — connects to a remote Playwright server via WebSocket (required in Docker); falls back to a locally installed Chromium when `PLAYWRIGHT_WS_URL` is unset (local development only)

## Getting Started

### What you need

The easiest way to run MindfulAPI is with **Docker**. Docker packages the application and all its dependencies (Redis, a headless browser) into containers that run identically on any machine — no manual setup of system libraries or runtimes required.

**Install Docker:**

- **macOS / Windows:** Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) — it includes everything you need.
- **Linux:** Install [Docker Engine](https://docs.docker.com/engine/install/) and the [Compose plugin](https://docs.docker.com/compose/install/linux/).

Verify the installation:

```bash
docker --version
docker compose version
```

> **`docker compose` vs `docker-compose`:** Modern Docker ships `compose` as a built-in subcommand (`docker compose`). Older standalone installs used a separate `docker-compose` binary. This README uses the modern form — if your system only has the legacy binary, replace `docker compose` with `docker-compose` throughout.

---

### Quickstart

Running MindfulAPI starts three containers together:

| Container | Purpose |
|---|---|
| `mindfulapi` | The NestJS API server (exposed on port 3000) |
| `redis` | Queue backend for asynchronous scan processing |
| `playwright` | Headless Chromium browser server used for page scanning |

**1. Copy the example environment file:**

```bash
cp .env.example .env
```

Open `.env` and review the settings. At minimum, set a strong `AUTH_TOKEN` before exposing the API publicly.

**2. Start all three services in the background:**

```bash
docker compose up -d
```

Docker pulls the required images on first run — this may take a minute.

**3. Verify everything is running:**

```bash
docker compose ps
```

All three services should show `running` (Redis will show `healthy`). If a service shows `exited`, inspect its output:

```bash
docker compose logs mindfulapi
docker compose logs redis
docker compose logs playwright
```

**4. Access the API:**

- API base: `http://localhost:3000`
- Interactive Swagger UI: `http://localhost:3000/api`
- OpenAPI JSON schema: `http://localhost:3000/api-json`

**5. Quick test:**

```bash
curl -X POST http://localhost:3000/scans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer changeme" \
  -d '{"mode":"single_url","url":"https://example.com"}'
```

**6. Stop the stack:**

```bash
docker compose down
```

This stops and removes the containers but keeps your data (stored in named Docker volumes). To also delete all stored data:

```bash
docker compose down --volumes
```

**Updating to the latest version:**

```bash
docker compose pull
docker compose up -d
```

---

### Network note (DDEV / TYPO3 integration)

If you run MindfulAPI alongside [DDEV](https://ddev.readthedocs.io/) (a local development environment commonly used with TYPO3), you can join the `ddev_default` Docker network so the API can reach TYPO3 sites at `*.ddev.site` hostnames without extra routing.

A ready-made Compose override file is included for this. It is an **override** — it must always be combined with the base `docker-compose.yml` and cannot be used on its own.

Set `COMPOSE_FILE` in your shell (or in `.env`) before running any `docker compose` command:

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.ddev.yml
docker compose up -d
```

Or pass the `-f` flag directly:

```bash
docker compose -f docker-compose.yml -f docker-compose.ddev.yml up -d
```

**DDEV uses self-signed TLS certificates for `*.ddev.site`.** Set `IGNORE_HTTPS_ERRORS=true` in your `.env` so the scanner accepts them:

```bash
IGNORE_HTTPS_ERRORS=true
```

**If you are not using DDEV,** use `docker compose` without any extra `-f` flags — only the base `docker-compose.yml` is needed, and keep `IGNORE_HTTPS_ERRORS=false` (the default).

---

### Local Development

For working on MindfulAPI itself you also need **Node.js 22+**.

```bash
# Install dependencies
npm install

# Install Playwright's Chromium browser
npx playwright install chromium

# Start Redis only (no API or Playwright containers)
docker compose -f dev.docker-compose.yml up -d

# Copy the env file
cp .env.example .env

# Start the dev server with hot reload
npm run start:dev
```

After making API changes, regenerate the OpenAPI spec:

```bash
npm run generate:openapi
```

## Configuration

All configuration is done via environment variables. Copy `.env.example` for a full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `AUTH_TOKEN` | _(unset)_ | Bearer token for API auth. **The server refuses to start when unset** unless `AUTH_DISABLED=true` is set. |
| `AUTH_DISABLED` | `false` | Set to `true` to explicitly run without authentication (only takes effect when `AUTH_TOKEN` is unset). **Not recommended.** |
| `DATABASE_PATH` | `./data/database.sqlite` | SQLite database file path |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | _(unset)_ | Redis password |
| `PLAYWRIGHT_WS_URL` | _(unset)_ | WebSocket URL of a remote Playwright server (e.g. `ws://playwright:3000`). **Required when running in Docker** — the production image does not include a browser. When unset, a locally installed Chromium is used (local development only). |
| `IGNORE_HTTPS_ERRORS` | `false` | Ignore TLS errors (useful for self-signed certificates) |
| `ENCRYPTION_KEY` | _(unset)_ | General 32-byte encryption key (base64 or hex) for sensitive persisted data (currently scan `basicAuth` credentials). Required only when encrypted fields are used. |
| `CLEANUP_ENABLED` | `true` | Enable scheduled deletion of old scans |
| `CLEANUP_RETENTION_DAYS` | `30` | How many days to keep scans |
| `CLEANUP_INTERVAL` | `0 2 * * *` | Cron schedule for cleanup |
| `CRAWL_CONCURRENCY` | `4` | Maximum pages analyzed in parallel **within a single scan** (crawl and url_list modes; clamped to 1–16) |
| `SCAN_CONCURRENCY` | `1` | Maximum scan jobs processed in parallel by the worker (clamped to 1–8). In-flight pages ≈ `SCAN_CONCURRENCY × CRAWL_CONCURRENCY`, all sharing one browser. |
| `SCAN_ALLOW_PRIVATE_TARGETS` | `false` | Allow scanning private/reserved network targets (see Security below) |
| `SCAN_TARGET_ALLOW_HOSTS` | _(unset)_ | Comma-separated hostnames exempt from the private-target block |
| `CORS_ORIGINS` | _(unset)_ | Comma-separated allowed CORS origins; unset disables CORS |
| `THROTTLE_TTL` | `60` | Rate-limit window in seconds |
| `THROTTLE_LIMIT` | `100` | Allowed requests per window per client |

Generate a secure encryption key (required when using encrypted fields such as `scanOptions.basicAuth`):

```bash
openssl rand -base64 32
```

---

## Security

- **Authentication is required by default.** The server will not start unless `AUTH_TOKEN` is set (or `AUTH_DISABLED=true` is set explicitly). Tokens are compared in constant time.
- **SSRF protection.** Scan targets that resolve to private or reserved network ranges (loopback, RFC 1918, link-local/cloud-metadata `169.254.169.254`, CGNAT, ULA, etc.) are rejected. To scan intranet/staging sites, set `SCAN_ALLOW_PRIVATE_TARGETS=true` (only when the API is not exposed to untrusted clients) or allow specific hosts with `SCAN_TARGET_ALLOW_HOSTS`. Note: targets are resolved before navigation, so a DNS-rebinding attacker with a very low TTL could still reach an internal address between the check and the fetch — acceptable for a self-hosted tool, but keep the API access-controlled.
- **Rate limiting** is applied globally (`THROTTLE_TTL` / `THROTTLE_LIMIT`); the `/health` probe is exempt.
- **Single replica.** SQLite and the in-process cleanup schedule assume exactly one API instance. Scale scan throughput with `SCAN_CONCURRENCY`, not by running multiple replicas. Back up the `/data` volume before upgrading, since the schema is auto-synced (no migrations).

---

## API Reference

The API is documented by an OpenAPI 3 specification generated directly from the code, so it never drifts from the implementation:

- **Interactive Swagger UI:** `http://localhost:3000/api` (while the server is running)
- **OpenAPI document:** `http://localhost:3000/api-json` (or `api-yaml`), and a committed copy at [`openapi.json`](openapi.json)

All endpoints are served under the `/v1` prefix (for example `POST /v1/scans`); the unauthenticated health probe is at `/health`. Errors follow [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json`.

### Breaking changes vs. 0.5.0

If you are upgrading a client (such as the mindfula11y TYPO3 extension):

- All routes are now under `/v1`.
- `GET /v1/scans` returns a paginated envelope `{ items, total, limit, offset }` of scan **summaries** (per-severity `issueCounts`, no `violations` array). Fetch `GET /v1/scans/:id` for full grouped violations.
- Errors are `application/problem+json` (`{ type, title, status, detail, instance }`; validation adds an `errors` array).
- `CrawlStrategy` values are snake_case (`same_hostname`, `same_domain`, `same_origin`).
- Cleanup: `POST /v1/cleanup` returns `{ deletedScans, cutoffDate }`; `GET /v1/cleanup/config` is now `GET /v1/cleanup/policy`.
- Authentication is required by default — the server refuses to start unless `AUTH_TOKEN` is set or `AUTH_DISABLED=true` is explicit.

New: `DELETE /v1/scans/:id`, `POST /v1/scans/:id/cancel`, `GET /health`, response caching on rules/reports, and rate limiting.

---

## Deploying to a Linux server

### Prerequisites

- A Linux server (VPS, bare metal, or cloud VM) running a systemd-based distribution such as Ubuntu 22.04 / Debian 12
- Docker Engine and the Compose plugin installed — follow the [official instructions](https://docs.docker.com/engine/install/ubuntu/)
- A user in the `docker` group (so you do not need `sudo` for every command)

### Steps

**1. Clone the repository** on the server:

```bash
git clone https://github.com/crinis/mindfulapi.git /opt/mindfulapi
cd /opt/mindfulapi
```

**2. Create your environment file:**

```bash
cp .env.example .env
```

Open `.env` and at minimum set:

```bash
AUTH_TOKEN=<your_strong_random_token>   # protect every API request
PORT=3000                               # or any port you prefer
ENCRYPTION_KEY=$(openssl rand -base64 32)  # required for basicAuth fields
IGNORE_HTTPS_ERRORS=false               # keep this false in production
```

**3. Start the stack:**

```bash
docker compose up -d
```

**4. (Optional) Expose via a reverse proxy**

It is strongly recommended to not expose port 3000 directly to the internet. Instead, put a reverse proxy such as [Caddy](https://caddyserver.com/) or Nginx in front, which handles TLS termination. Example Caddy snippet:

```
your-domain.example.com {
    reverse_proxy localhost:3000
}
```

Caddy automatically provisions a Let's Encrypt TLS certificate.

**5. Open the firewall only as needed:**

If you go through a reverse proxy (recommended) you only need to expose ports 80 and 443, not 3000. On Ubuntu with `ufw`:

```bash
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

### Keeping the API running across reboots

Docker's restart policy in `docker-compose.yml` is set to `unless-stopped`. This means containers restart automatically after a reboot as long as the Docker daemon itself starts on boot — which is the default for Docker Engine installed via `apt`.

Verify Docker starts on boot:

```bash
systemctl is-enabled docker    # should print "enabled"
```

### Updating

```bash
cd /opt/mindfulapi
git pull
docker compose pull
docker compose up -d
```

## Use with mindfula11y (TYPO3)

MindfulAPI is designed to integrate with the [mindfula11y](https://github.com/crinis/mindfula11y) TYPO3 extension as an external accessibility scanner backend. The TYPO3 extension sends scan requests to this API and displays the results directly in the TYPO3 backend, enabling editors and integrators to review and fix accessibility issues without leaving the CMS.

Deploy MindfulAPI alongside your TYPO3 installation. For DDEV-based TYPO3 setups, use the included `docker-compose.ddev.yml` override file to join the `ddev_default` network — see [Network note (DDEV / TYPO3 integration)](#network-note-ddev--typo3-integration) above. Configure the TYPO3 extension with the API base URL (`http://mindfulapi:3000` from within the DDEV network, or `http://localhost:3000` from the host) and the auth token.

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
