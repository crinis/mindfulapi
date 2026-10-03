# MindfulAPI

A self-hosted REST API for automated web accessibility scanning, powered by [axe-core](https://github.com/dequelabs/axe-core) and [Playwright](https://playwright.dev/).

MindfulAPI is the external scanner backend for the TYPO3 extension [crinis/mindfula11y](https://github.com/crinis/mindfula11y). You can also run it standalone or connect any other client.

> **Disclaimer**
> - Significant parts of this application were generated or refined with the help of AI tools.
> - Run MindfulAPI only in a secure environment and apply proper hardening before exposing it publicly.

## Features

- **Axe-core scanning** — industry-standard accessibility rules mapped to WCAG 2 / Section 508
- **Three scan modes** — a single URL, an explicit list of URLs, or a crawl from seed URLs
- **Asynchronous processing** — scans run in the background via a Redis-backed queue (BullMQ)
- **Scoped scanning** — target a CSS selector instead of the whole page
- **Rule filtering** — run only the axe rules you care about
- **Basic auth support** — optional per-scan HTTP Basic credentials for protected targets, sent only to the first target's origin
- **Scan history** — results are stored in SQLite and queryable via the API
- **HTML & PDF reports** — accessible, print-ready reports generated from scan results
- **Optional authentication** — protect the API with a Bearer token, or leave it open
- **Automated cleanup** — scheduled deletion of old scan data
- **Flexible browser setup** — connects to a remote Playwright server via WebSocket (required in Docker); falls back to a locally installed Chromium when `PLAYWRIGHT_WS_URL` is unset (local development only)
- **Optional AI audit** — opt-in LLM skills that judge what axe-core cannot: image alt-text _quality_, plus heading, link and form-label _semantics_ and page-title descriptiveness (up to WCAG AAA), returned alongside the deterministic results ([details](#ai-accessibility-audit-optional))

## Getting Started

### What you need

The easiest way to run MindfulAPI is **Docker**. It runs the API and its dependencies (Redis, a headless browser) in containers, with no manual setup of system libraries or runtimes.

- **macOS / Windows:** install [Docker Desktop](https://www.docker.com/products/docker-desktop/).
- **Linux:** install [Docker Engine](https://docs.docker.com/engine/install/) and the [Compose plugin](https://docs.docker.com/compose/install/linux/).

Verify the installation:

```bash
docker --version
docker compose version
```

> **`docker compose` vs `docker-compose`:** this README uses the built-in `docker compose` subcommand. If your system only has the legacy standalone binary, use `docker-compose` instead.

---

### Quickstart

The stack consists of three containers:

| Container | Purpose |
|---|---|
| `mindfulapi` | The NestJS API server (published on `127.0.0.1:3000`, this host only) |
| `redis` | Queue backend for asynchronous scan processing |
| `playwright` | Headless Chromium browser server used for page scanning |

**1. Create your `.env` file:**

```bash
cp .env.example .env
```

Set `AUTH_TOKEN` in `.env` to a strong random value, for example the output of `openssl rand -hex 32`. `.env.example` ships it empty, and the API refuses to start until it is set: the `mindfulapi` container exits with *"AUTH_TOKEN is not set"*. `docker compose` itself refuses to start when the `AUTH_TOKEN` line is missing from `.env`. The placeholder `your-secure-api-token-here` that older versions of `.env.example` contained is refused as well. See [Configuration](#configuration) for all other variables.

**2. Start all services in the background:**

```bash
docker compose up -d
```

The first run pulls the images, which may take a minute.

**3. Check that everything is running:**

```bash
docker compose ps
```

All three services should show `running` (Redis also shows `healthy`). If a service shows `exited`, read its logs:

```bash
docker compose logs mindfulapi
docker compose logs redis
docker compose logs playwright
```

**4. Open the API:**

- API base: `http://localhost:3000`
- Interactive Swagger UI: `http://localhost:3000/api`
- OpenAPI JSON schema: `http://localhost:3000/api-json`

**5. Run a test scan:**

```bash
AUTH_TOKEN=<the AUTH_TOKEN value from your .env>
curl -X POST http://localhost:3000/v1/scans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d '{"mode":"single_url","url":"https://example.com"}'
```

The response contains the scan `id`. Poll `GET /v1/scans/<id>` until `status` is `completed`, `failed`, or `canceled`.

**6. Stop the stack:**

```bash
docker compose down
```

Your data stays in named Docker volumes. To delete it as well:

```bash
docker compose down --volumes
```

To update, see [Updating](#updating).

### Local Development

To work on MindfulAPI itself you also need **Node.js 22+**.

```bash
# Install dependencies
npm install

# Install Playwright's Chromium browser
npx playwright install chromium

# Start Redis only (no API or Playwright containers), on 127.0.0.1:6379
docker compose -f dev.docker-compose.yml up -d

# Copy the env file, then set AUTH_TOKEN and NODE_ENV=development
cp .env.example .env

# Start the dev server with hot reload
npm run start:dev
```

> **`SCAN_CONCURRENCY` and `CLEANUP_INTERVAL` under `npm run start:dev`:** both are read before the config module loads `.env`. Set them in your shell instead, e.g. `SCAN_CONCURRENCY=2 npm run start:dev`. `npm start` (`node --env-file=.env`) and Docker are not affected.

After API changes, regenerate the OpenAPI spec:

```bash
npm run generate:openapi
```

## Deploying to a Linux server

### Prerequisites

- A Linux server (VPS, bare metal, or cloud VM) with a systemd-based distribution such as Ubuntu 22.04 / Debian 12
- Docker Engine and the Compose plugin ([official instructions](https://docs.docker.com/engine/install/ubuntu/))
- A user in the `docker` group, so you do not need `sudo` for every command

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

Set at least these values in `.env`:

```bash
AUTH_TOKEN=<your_strong_random_token>   # protect every API request
PORT=3000                               # or any port you prefer
ENCRYPTION_KEY=<output of: openssl rand -base64 32>  # required for basicAuth fields
IGNORE_HTTPS_ERRORS=false               # keep this false in production
```

`.env` is not a shell script, so `$(...)` is not executed. Run `openssl rand -base64 32` (and e.g. `openssl rand -hex 32` for the token) in a terminal and paste the output.

**3. Start the stack:**

```bash
docker compose up -d
```

**4. (Optional, strongly recommended) Put a reverse proxy in front.**

The API speaks plain HTTP. Use a reverse proxy such as [Caddy](https://caddyserver.com/) or Nginx on the same host for TLS termination. `docker-compose.yml` publishes the API on `127.0.0.1:3000` only (`BIND_ADDRESS`), so the proxy reaches it there while other hosts cannot. With Caddy, which provisions a Let's Encrypt certificate automatically:

```
your-domain.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

If the proxy runs in a container instead, attach it to the Compose network and proxy to `mindfulapi:3000`. Behind a proxy, also set `TRUST_PROXY=1` so rate limiting counts each client separately (see [Security](#security)).

**5. Open only the ports you need.**

Behind a reverse proxy, open ports 80 and 443. On Ubuntu with `ufw`:

```bash
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

**ufw does not filter ports that Docker publishes:** Docker's own firewall rules handle container traffic before ufw sees it ([Docker docs](https://docs.docker.com/engine/network/packet-filtering-firewalls/#docker-and-ufw)). Port 3000 stays private only because it is published on `127.0.0.1`. Publishing on every interface (`BIND_ADDRESS=0.0.0.0`) is an explicit choice for setups without a reverse proxy on the same host; the API is then reachable over plain HTTP from anywhere the network allows, whatever ufw says, so restrict it with a firewall in front of the server or Docker's `DOCKER-USER` chain.

### Keeping the API running across reboots

All services use the `unless-stopped` restart policy. They come back after a reboot as long as the Docker daemon starts on boot, which is the default for Docker Engine installed via `apt`. Check it:

```bash
systemctl is-enabled docker    # should print "enabled"
```

### Container image tags

Images are published to `ghcr.io/crinis/mindfulapi` for AMD64 and ARM64. Each tag is a channel with its own stability guarantee:

| Tag | Meaning |
|---|---|
| `latest` | Newest stable release. Updated only by a stable SemVer Git tag, never by `main` or a prerelease. |
| `0.7.0` / `v0.7.0` | One exact release. The `v` form mirrors the Git tag; the unprefixed form follows container-version conventions. |
| `0.7` | Newest stable patch release in that minor line. |
| `1` | Newest stable release in that major line. There is no broad `0` tag, because pre-1.0 releases may be incompatible. |
| `dev` | Newest successful build from `main`. Unreleased and possibly unstable. |
| `sha-abcdef0` | Build from one exact Git commit. |

- Prerelease tags such as `v0.8.0-rc.1` publish only their exact version tags. They never update `latest`, `0.8`, or a major-version tag.
- For reproducible deployments, pin an exact version or the image digest. Moving tags (`latest`, `0.7`, `dev`) receive updates.

The Compose file uses `latest`. To pick another channel, set it in `.env`:

```bash
MINDFULAPI_IMAGE=ghcr.io/crinis/mindfulapi:0.7.0
```

Then pull and recreate the service:

```bash
docker compose pull
docker compose up -d
```

### Updating

Back up the `/data` volume first: the database schema is auto-synced, with no migrations.

```bash
cd /opt/mindfulapi   # your clone of the repository
git pull
docker compose pull
docker compose up -d
```

**Upgrading from an image that ran as root.** The container now runs as the unprivileged `node` user (uid 1000). A `/data` volume created by an older root image is not writable for it, and SQLite fails on startup with *"attempt to write a readonly database"*. Fix the ownership once with a one-off container that mounts the same volume:

```bash
docker compose down
docker compose run --rm --no-deps --user root --entrypoint sh mindfulapi \
  -c 'chown -R node:node /data'
docker compose up -d
```

#### Breaking changes vs. 0.5.0

If you upgrade a client (such as the mindfula11y TYPO3 extension):

- All routes are now under `/v1`.
- `GET /v1/scans` returns a paginated envelope `{ items, total, limit, offset }` of scan **summaries** (per-severity `issueCounts`, no `violations` array). Fetch `GET /v1/scans/:id` for full grouped violations.
- Errors are `application/problem+json` (`{ type, title, status, detail, instance }`; validation adds an `errors` array).
- `CrawlStrategy` values are snake_case (`same_hostname`, `same_domain`, `same_origin`).
- Cleanup: `POST /v1/cleanup` returns `{ deletedScans, cutoffDate }`; `GET /v1/cleanup/config` is now `GET /v1/cleanup/policy`.
- Authentication is required by default — the server refuses to start unless `AUTH_TOKEN` is set or `AUTH_DISABLED=true` is explicit.

New: `DELETE /v1/scans/:id`, `POST /v1/scans/:id/cancel`, `GET /health`, response caching on rules/reports, and rate limiting. The [optional AI audit](#ai-accessibility-audit-optional) adds an `aiAudit` request field, `aiAudit`/`agentFindings` response fields, and a new `analyzing` scan status. These are additive, but clients must tolerate the new status value and fields.

## Configuration

All configuration uses environment variables; [`.env.example`](.env.example) lists them all. An empty value (`VAR=`) means the same as leaving the variable unset, so the default applies. Values are validated at startup: an out-of-range or malformed value (e.g. `SCAN_CONCURRENCY=12`) stops the server with an error instead of being clamped.

**With Docker Compose,** every variable in `.env` reaches the API container, except the service wiring: `NODE_ENV`, `DATABASE_PATH`, `PLAYWRIGHT_WS_URL`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` and `PORT` are pinned by `docker-compose.yml` to the bundled containers. `PORT` and `BIND_ADDRESS` in `.env` only change where the API is published on the host.

**Server and authentication**

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Any value other than `production` enables SQL query logging |
| `PORT` | `3000` | HTTP server port (1–65535). With Docker Compose: the published host port |
| `BIND_ADDRESS` | `127.0.0.1` | Compose only: host address the API port is published on. The default allows only this host (e.g. a reverse proxy). `0.0.0.0` publishes on every interface, past host firewalls such as ufw — see [Deploying](#deploying-to-a-linux-server) |
| `AUTH_TOKEN` | _(unset)_ | Bearer token for API auth. **The server refuses to start when unset** unless `AUTH_DISABLED=true`, and always refuses the old `.env.example` placeholder `your-secure-api-token-here` |
| `AUTH_DISABLED` | `false` | `true` runs without authentication (only when `AUTH_TOKEN` is unset). **Not recommended** |
| `CORS_ORIGINS` | _(unset)_ | Comma-separated allowed CORS origins; unset disables CORS |
| `THROTTLE_TTL` | `60` | Rate-limit window in seconds |
| `THROTTLE_LIMIT` | `100` | Allowed requests per window per client |
| `TRUST_PROXY` | _(unset)_ | Proxies whose `X-Forwarded-For` the API trusts for the client address that rate limiting counts by: `true`, `false`, a hop count (1–32), or a comma-separated list of IP addresses, CIDR subnets, `loopback`, `linklocal`, `uniquelocal`. Unset trusts none. See [Security](#security) |

**Storage and services**

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_PATH` | `./data/database.sqlite` | SQLite database file path |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | _(unset)_ | Redis password |
| `PLAYWRIGHT_WS_URL` | _(unset)_ | WebSocket URL of a remote Playwright server (e.g. `ws://playwright:3000`). **Required in Docker** — the production image has no browser. Unset uses a locally installed Chromium (local development only) |
| `ENCRYPTION_KEY` | _(unset)_ | 32-byte key (base64 or hex) for sensitive stored data, currently scan `basicAuth` credentials. Required only when such fields are used. Generate with `openssl rand -base64 32` |
| `MINDFULAPI_IMAGE` | `ghcr.io/crinis/mindfulapi:latest` | Compose only: the image to run (see [Container image tags](#container-image-tags)) |

**Scanning**

| Variable | Default | Description |
|----------|---------|-------------|
| `IGNORE_HTTPS_ERRORS` | `false` | Ignore TLS errors (e.g. self-signed certificates) |
| `CRAWL_CONCURRENCY` | `4` | Max pages analyzed in parallel **within one scan** (`crawl` and `url_list`; 1–16) |
| `SCAN_CONCURRENCY` | `1` | Max scan jobs processed in parallel (1–8). In-flight pages ≈ `SCAN_CONCURRENCY × CRAWL_CONCURRENCY`, all sharing one browser |
| `SCAN_ALLOW_PRIVATE_TARGETS` | `false` | Allow private/reserved network targets (see [Security](#security)) |
| `SCAN_TARGET_ALLOW_HOSTS` | _(unset)_ | Comma-separated hostnames exempt from the private-target block (exact, case-insensitive; no wildcards) |

**Cleanup**

| Variable | Default | Description |
|----------|---------|-------------|
| `CLEANUP_ENABLED` | `true` | Scheduled deletion of old scans. `POST /v1/cleanup` works regardless |
| `CLEANUP_RETENTION_DAYS` | `30` | Days to keep scans. `0` deletes every scan on each run |
| `CLEANUP_INTERVAL` | `0 2 * * *` | Cron schedule for cleanup |

**AI audit** (see [AI accessibility audit](#ai-accessibility-audit-optional))

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_ENABLED` | `false` | Enable the AI audit |
| `AGENT_PROVIDER` | _(unset)_ | `openai`, `anthropic`, or `openai-compatible` (OpenRouter / local models) |
| `AGENT_MODEL` | _(unset)_ | Model for every skill. Optional for OpenAI (unset → [tuned per-skill profile](#choosing-an-apigateway-and-model)); required for other providers |
| `AGENT_API_KEY` | _(unset)_ | Provider API key; validated lazily, never logged |
| `AGENT_BASE_URL` | _(unset)_ | Base URL for `openai-compatible` (OpenRouter or a local server) |
| `AGENT_SKILLS` | `image_alt_text,heading_structure,link_purpose,form_labels,page_title` | Skills clients may request. Unset or empty means all; unknown values are silently ignored |
| `AGENT_ALLOWED_SCAN_MODES` | `single_url` | Scan modes that may request an AI audit: `single_url`, `url_list`, `crawl`. Not yet released: available in the `dev` image; releases up to 0.7.1 allow every mode |
| `AGENT_REASONING_EFFORT` | _(unset)_ | `none`, `minimal`, `low`, `medium`, `high`, `xhigh` for a reasoning `AGENT_MODEL`. `gpt-5.4+` reject `minimal` (use `none`); only the original `gpt-5-nano`/`gpt-5-mini` accept it. How it combines with the profile: [Per-skill model selection](#per-skill-model-selection) |
| `AGENT_SKILL_<ID>_{PROVIDER,MODEL,API_KEY,BASE_URL,REASONING_EFFORT}` | _(inherits `AGENT_*` / profile)_ | Per-skill override, e.g. `AGENT_SKILL_HEADING_STRUCTURE_REASONING_EFFORT`. See [Per-skill model selection](#per-skill-model-selection) |
| `AGENT_CONCURRENCY` | `4` | Concurrent requests during evaluation, one per unit — an image (`image_alt_text`) or a page (text-only skills) (1–16) |
| `AGENT_MAX_UNITS_PER_PAGE` | `30` | Cap on collected work units per page |
| `AGENT_MAX_UNITS_PER_SCAN` | `200` | Cap on evaluated work units per scan (see [cost note](#per-skill-model-selection)) |
| `AGENT_MAX_TOKENS_PER_REQUEST` | `2000` | Output-token cap per request (includes reasoning tokens) |
| `AGENT_REQUEST_TIMEOUT_MS` | `60000` | Per-request timeout |
| `AGENT_MAX_IMAGE_BYTES` | `1500000` | Skip element screenshots larger than this |
| `AGENT_TEMPERATURE` | `0` | Sampling temperature (0–2); omitted whenever a reasoning effort applies |

## Security

- **Authentication is required by default.** The server does not start unless `AUTH_TOKEN` is set (or `AUTH_DISABLED=true` explicitly), and never with the placeholder token that older versions of `.env.example` shipped. Tokens are compared in constant time.
- **SSRF protection.** Hosts that resolve to private or reserved ranges (loopback, RFC 1918, link-local/cloud-metadata `169.254.169.254`, CGNAT, ULA, etc., including IPv6 addresses that embed such an IPv4 address: IPv4-mapped, IPv4-compatible, NAT64 `64:ff9b::/96`) are blocked. In the browser:
  - **Nearly every request a page starts** (navigation, iframe, image, script, stylesheet, fetch/XHR, worker and service-worker requests) is checked before it is sent, and aborted when blocked. The exception is speculative navigation — speculation-rules prefetch and prerender (`<script type="speculationrules">`) — which Chromium runs in a pipeline Playwright does not route: it can issue a blind GET to a blocked host. The prefetched response is partitioned by Chromium and is not exposed to the scanner or to page script, so it is a blind request like a redirect hop, not a content read (see Limitations).
  - **Redirect hops** are checked as they start. Playwright cannot stop a hop in flight, so the redirected request is still sent and its response reaches the browser. The page is then closed and counted as failed, and the scanner never analyses, stores, crawls or sends to the AI provider anything the page loaded. A malicious page's own JavaScript can still read a CORS-readable response from the blocked host and exfiltrate it to an allowed host in the short window before the page closes; fully closing this needs an egress proxy (see below).
  - **The final URL** of every page is checked again after navigation, before analysis.
  - **WebSockets** opened by a page are checked before they connect. The check is Playwright's page-level `WebSocket` shim: it does not reach dedicated workers, and page script can get past it, so it is defence in depth only. `SharedWorker`, `WebSocketStream`, `WebTransport` and WebRTC peer connections are removed from pages because Playwright cannot intercept their connections; dedicated workers keep `WebSocket`, `WebSocketStream` and `WebTransport`. Service workers stay enabled because their requests are checked like page requests.
  - To scan intranet/staging sites, allow specific hosts with `SCAN_TARGET_ALLOW_HOSTS`, or set `SCAN_ALLOW_PRIVATE_TARGETS=true` — only when the API is not exposed to untrusted clients.
  - Limitations: the policy resolves hosts independently of the browser's DNS, so a DNS-rebinding attacker with a very low TTL could flip a record between check and fetch. Redirect hops (see above), sockets opened inside a dedicated worker, and speculation-rules prefetch/prerender can still send a request to a blocked address; the scanner never stores or reports what comes back, but a malicious page can read and exfiltrate a CORS-readable redirect-hop response during the close window. Closing these completely needs an egress proxy. This residual is acceptable for scanning trusted sites from an access-controlled API; do not point the scanner at untrusted content without an egress proxy.
- **Keep the Playwright run-server out of reach of scanned pages.** In Docker the browser runs inside the `playwright` container, next to the run-server that controls it, so a scanned page can address the run-server at its own loopback address and at `playwright:3000`.
  - Ordinary requests and page WebSockets to either address are blocked by the SSRF protection above (both are private addresses), unless `SCAN_ALLOW_PRIVATE_TARGETS=true`.
  - A WebSocket the shim does not see (for example one opened in a dedicated worker) is not checked, and `run-server --host 0.0.0.0` as used in `docker-compose.yml` does not check the connecting origin. A malicious page could then use the Playwright protocol to open browsers and load URLs, internal ones included, from inside the container.
  - Network isolation cannot separate a page from the run-server: they share the container's network. Give the run-server an unguessable endpoint path instead: in `docker-compose.yml`, append `--path /<random secret>` to the `playwright` command and the same path to the API's `PLAYWRIGHT_WS_URL` (e.g. `ws://playwright:3000/<random secret>`). Connections to any other path are refused; the healthcheck keeps working. Never add `--unsafe`. Complete protection needs an egress proxy or scanning only trusted sites; keep the API access-controlled.
- **Basic Auth credentials** (`scanOptions.basicAuth`) are sent only to the origin (scheme, host and port) of the first target URL, in answer to its 401 challenge. Subresources, redirect targets and crawled pages on other origins never receive them. If the target redirects to another origin (http → https, `example.com` → `www.example.com`), use the final URL as the target. Split scans whose targets span several protected origins.
- **Rate limiting** applies to every request per client address (`THROTTLE_TTL` / `THROTTLE_LIMIT`) before authentication, so requests with a wrong token count too and tokens cannot be guessed at full speed. `/health` is exempt.
  - Behind a reverse proxy every request comes from the proxy's address, so all clients share one limit until `TRUST_PROXY` names the proxy. For one proxy in front, set `TRUST_PROXY=1`: the client address is then the last `X-Forwarded-For` entry, the one the proxy adds (Caddy does this by default; Nginx needs `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`).
  - With Docker Compose, a proxy on the host reaches the container from the Docker network's gateway address, not from loopback, so `TRUST_PROXY=loopback` does not match; use the hop count.
  - Set `TRUST_PROXY` only when every request passes the proxy (the default `BIND_ADDRESS=127.0.0.1` with the proxy on the same host). A client that reaches the API directly could otherwise pick its own address with `X-Forwarded-For` and escape the limit.
- **Request limits.** JSON and form bodies: 1 MB. `url_list`: up to 500 URLs. `crawl`: up to 50 seed URLs, `maxPages` up to 5000 (default 250), `maxDepth` up to 20 (default 4).
- **Non-root container.** The process runs as the unprivileged `node` user (uid 1000), so `/data` must be writable by it. Fresh installs handle this; upgrades from an old root image need a one-time `chown` (see [Updating](#updating)).
- **Single replica.** SQLite and the in-process cleanup schedule assume exactly one API instance. Scale throughput with `SCAN_CONCURRENCY`, not with replicas.

## AI accessibility audit (optional)

Axe-core is deterministic: it can tell that an image _has_ an `alt` attribute, but not whether the text is _accurate, meaningful, or correctly decorative_. The AI audit adds LLM **skills** that make those judgments. Their findings are returned **alongside** the axe results, never replacing them.

- **Disabled by default.** Enable it with `AGENT_ENABLED=true` and a provider ([Choosing an API/gateway and model](#choosing-an-apigateway-and-model)).
- **Opt-in per scan.** Each scan request must ask for it. By default it runs every server-enabled skill; clients may request a subset.
- **`single_url` scans only by default.** Allow more modes with `AGENT_ALLOWED_SCAN_MODES=single_url,url_list,crawl` (this also restores the previous all-mode behavior). The restriction ships in the `dev` image and the next release; the `latest` image (0.7.1) still allows every mode.

### How it works

- **Deterministic-first.** A skill judges only _semantics_ that axe cannot check. It never re-reports what axe or an attribute/structure check already settles (see the last column of [Skills](#skills)), so there are no duplicates and no wasted tokens.
- **Minimal, structured evidence.** Evidence is collected while the page is live and kept small (see [Skills](#skills)).
- **Forced structured output.** Every request returns a fixed verdict with a confidence score, and each finding records its WCAG success criterion. Low-confidence or unjudgeable cases become `insufficient_evidence` findings flagged for human review.
- **Failed requests are reported, never hidden.** A work unit whose request fails counts in `aiAudit.tasksFailed` and produces no findings; no verdict is invented for it. Failures include a missing or rejected API key, a quota or rate limit, a network error or timeout, and a model answer that does not match the expected format. The SDK retries a retryable API error once; an invalid answer is not retried. The scan still completes with its axe results. "No AI findings" therefore means "no problems found" only when `tasksFailed` is `0`.
- **New lifecycle status.** With an AI audit, a scan moves `pending → running` (axe) `→ analyzing` (agents) `→ completed`. Any scan can instead end as `failed` or `canceled`. Clients must tolerate `analyzing`.
- **Reports.** AI findings also appear in the HTML and PDF reports.

### Skills

| Skill | Judges (WCAG) | Axe already covers (not re-reported) |
| --- | --- | --- |
| `image_alt_text` | Accuracy / redundancy / decorative correctness of an _existing_ accessible name (1.1.1) | Missing alt / accessible name |
| `heading_structure` | Non-descriptive or vague headings, confusing duplicates, `h1`↔topic mismatch (2.4.6); content sections with no heading (**2.4.10, AAA**); headings faked with styled `<p>`/`<div>` (1.3.1) | Skipped/out-of-order levels, empty headings, missing `<h1>` |
| `link_purpose` | Generic / non-descriptive / raw-URL link text (2.4.4, A); link names that only make sense in context (**2.4.9, AAA**). Only judges links that already have a name | Missing link name, identical names pointing to different destinations (`identical-links-same-purpose`) |
| `form_labels` | Uninformative or ambiguous field labels (2.4.6); fields needing format/constraint instructions the user never gets (3.3.2) | Missing / title-only / multiple labels, missing button & select names (plus deterministic facts left to future checks: required state, placeholder-as-label, control grouping, autocomplete tokens) |
| `page_title` | Placeholder/boilerplate titles ("Untitled Document", "Home") or titles that don't describe the page (2.4.2, A). Only judges a _present_ `<title>` | Missing / empty `<title>` (`document-title`); cross-page uniqueness left to a future deterministic check |

`page_title` is **SEO-safe**: it never flags a title for its brand name, length, or keywords, and a suggested fix keeps the brand and adds the missing topic.

**Evidence sent per request:**

| Skill | Requests | Evidence (sent to the LLM provider) |
| --- | --- | --- |
| `image_alt_text` | one per image (vision) | Cropped element screenshot + accessible-name attributes |
| `heading_structure` | one per page (text-only) | Heading outline (level, text, short content snippet each; headings in open shadow roots of web components included), plus styled-block and unheaded-section candidates |
| `link_purpose` | one per page (text-only) | Deduplicated inventory of named links: accessible name, compact destination, surrounding context. Repeated nav/footer links collapse to one line |
| `form_labels` | one per page (text-only) | Form controls: accessible name and its source, control type, placeholder, existing described-by instructions, constraint hints |
| `page_title` | one per page (text-only) | The `<title>` plus top headings and meta description as topic context |

On each page, the one-per-page skills get their request first; `image_alt_text` uses the rest of `AGENT_MAX_UNITS_PER_PAGE`. When `AGENT_MAX_UNITS_PER_SCAN` runs out, images are dropped before page-level requests.

Evidence collection ends 15 seconds before the two-minute page limit. Images that never stand still (for example script-driven motion) can take seconds per screenshot; when the time runs out, only the evidence collected so far is judged, and the page keeps its axe results. Images that are not rendered (such as inside `content-visibility: hidden`) are skipped, and CSS animations are frozen for the screenshot.

> **Privacy.** When the AI audit runs, the evidence above is sent to the configured LLM provider. Only enable it with a provider you trust, and consider a self-hosted/local model for sensitive sites.

### Requesting an audit

```jsonc
POST /v1/scans
{
  "mode": "single_url",
  "url": "https://example.com",
  "aiAudit": {}
}
```

- Omit `skills` to run every skill enabled by `AGENT_SKILLS`, or pass an explicit list for a subset.
- `scanOptions.rootElement` limits the AI audit to the same region as axe: the skills collect only images, headings, links and form controls inside the matching elements. `page_title` still judges the page's `<title>`.
- The request returns a `400` problem if the audit is disabled server-side, the mode is excluded by `AGENT_ALLOWED_SCAN_MODES`, or a skill is not whitelisted.
- It also returns a `400` problem if a requested skill cannot reach a model: no provider, an unsupported provider, no model, no API key for `openai` or `anthropic`, or no base URL for `openai-compatible`. The problem's `detail` names the settings to fix. An invalid key or an unreachable endpoint is only detected when the requests run, and then counts in `tasksFailed`.
- Scan responses gain an `aiAudit` summary and an `agentFindings` array; list summaries gain `agentFindingCount`.
- `aiAudit` holds `status` (`pending`, `running`, `completed`, or `skipped` when nothing was eligible or the scan failed/was canceled first), `requestedSkills`, and the task counters `tasksTotal`, `tasksCompleted` and `tasksFailed`. `completed` means the evaluation finished, not that every unit succeeded: units in `tasksFailed` were not checked.

Every `agentFindings` entry has the **same shape regardless of skill**, so clients render them uniformly:

| Field | Meaning |
| --- | --- |
| `skill` | Which skill produced it (`image_alt_text`, `heading_structure`, …) |
| `category` | Per-skill verdict (e.g. `redundant`, `vague_or_generic`) |
| `wcag` | WCAG success criterion the finding maps to (e.g. `1.1.1`, `2.4.10`) |
| `severity` | Shared axe impact scale (`minor`…`critical`) |
| `confidence` | Model confidence, 0–1 |
| `needsHumanReview` | `true` when low-confidence/unjudgeable — triage flag |
| `message` | **Human-readable problem description** |
| `suggestion` | Concrete fix, when offered |
| `pageUrl`, `selector` | Where the problem is |
| `details` | Skill-specific extras (e.g. `currentAlt` and `src` for images, `suggestedLevel` for headings) |
| `model` | Provenance — the model that produced the finding |

### Choosing an API/gateway and model

The harness is built on the Vercel AI SDK, so one set of environment variables reaches many providers. Choose **where** requests go with `AGENT_PROVIDER` (+ `AGENT_BASE_URL`) and **which model** with `AGENT_MODEL`:

| Goal | `AGENT_PROVIDER` | `AGENT_BASE_URL` | `AGENT_MODEL` (example) |
|------|------------------|------------------|-------------------------|
| OpenAI directly | `openai` | _(unset)_ | _(unset → tuned GPT-5 per-skill profile)_ or e.g. `gpt-5.4-mini` |
| Anthropic directly | `anthropic` | _(unset)_ | `claude-haiku-4-5` |
| **OpenRouter** (one key → hundreds of models) | `openai-compatible` | `https://openrouter.ai/api/v1` | `anthropic/claude-haiku-4.5`, `meta-llama/llama-3.2-90b-vision-instruct` |
| DeepSeek | `openai-compatible` | `https://api.deepseek.com` | `deepseek-chat` |
| **Local** (Ollama) | `openai-compatible` | `http://localhost:11434/v1` | `llama3.2-vision` |
| **Local** (vLLM / LM Studio) | `openai-compatible` | `http://localhost:8000/v1` | _(the served model id)_ |

```bash
AGENT_ENABLED=true
AGENT_PROVIDER=openai-compatible
AGENT_BASE_URL=https://openrouter.ai/api/v1
AGENT_MODEL=anthropic/claude-haiku-4.5
AGENT_API_KEY=sk-or-...
AGENT_SKILLS=image_alt_text,heading_structure,link_purpose,form_labels,page_title   # skills available to audit requests
```

Model quality varies: supporting many models is about reach, not guarantees. Weaker models produce weaker structured output, so pick a capable vision model for `image_alt_text`.

**Picking a model: the OpenAI profile.** Set `AGENT_PROVIDER=openai` and leave `AGENT_MODEL` unset. Each skill then runs on the model and reasoning effort that tested best for it — no per-skill config needed. The profile targets OpenAI's current **GPT-5 line** (gpt-4.x is legacy). It comes from per-skill A/B testing, tuned for accuracy **without over-flagging**: a false "issue" on a clean page erodes trust as much as a miss.

| Skill | OpenAI profile | Effort | Why |
| --- | --- | --- | --- |
| `image_alt_text` | `gpt-5.4-mini` | `none` | Needs a **vision** model; reads the screenshot and judges accurately |
| `heading_structure` | `gpt-5.4-mini` | `low` | Multi-verdict structural reasoning; the only config with full recall **and** zero false positives (9/9). `none`-effort tiers over-flag clean pages |
| `form_labels` | `gpt-5.4-nano` | `none` | GPT-5's reasoning-native nano catches the descriptiveness/instruction gaps the legacy nano missed — no need for `mini` |
| `link_purpose` | `gpt-5.4-nano` | `none` | Simple text classification; nano matched the larger models |
| `page_title` | `gpt-5.4-nano` | `none` | Simple title-vs-content check; nano matched the larger models |

Weak models or efforts fail quietly, by under-reporting (false "appropriate") or by over-reporting on clean pages. The profile therefore spends extra reasoning only where the cheap setting measurably failed (`heading_structure`). Reasoning models reject a non-default temperature, so the harness omits `temperature` and passes the reasoning effort automatically.

Only OpenAI has a profile today. Other providers (Anthropic, and `openai-compatible` gateways such as OpenRouter, DeepSeek, or local servers) need an explicit `AGENT_MODEL`. Adding a profile is a one-object change in `src/config/configuration.ts`.

### Per-skill model selection

Set only what you want to change; the profile fills in the rest.

**Model**, highest priority first:

1. `AGENT_SKILL_<ID>_MODEL` — explicit per-skill model
2. `AGENT_MODEL` — one model for every skill (overrides the whole profile)
3. The provider profile above

**Reasoning effort**, highest priority first:

1. `AGENT_SKILL_<ID>_REASONING_EFFORT`
2. The profile's effort — only when the profile also supplied the model
3. `AGENT_REASONING_EFFORT` (global)

So `AGENT_REASONING_EFFORT` has no effect on skills that use a profile model; use the per-skill variable to change their effort. The effort is sent only to the `openai` provider. `anthropic` and `openai-compatible` ignore it, but setting it still omits `temperature` for that skill.

`AGENT_SKILL_<ID>_{PROVIDER,API_KEY,BASE_URL}` route a single skill to an entirely different gateway. `<ID>` is the upper-cased skill id (`image_alt_text` → `IMAGE_ALT_TEXT`). Unset fields fall back to their `AGENT_*` default, except that a key and a base URL stay with the endpoint they were configured for:

- An override that sets a **different provider** inherits neither `AGENT_API_KEY` nor `AGENT_BASE_URL`.
- An override that sets its **own base URL** does not inherit `AGENT_API_KEY`.

So the global key is never sent to another gateway or to a key-less local server. Give such a skill its own `AGENT_SKILL_<ID>_API_KEY` when its endpoint needs one; for `openai` and `anthropic` a scan request is rejected until it has one.

```bash
# Zero-config optimized set: pick the provider, leave AGENT_MODEL unset →
# every skill uses its tuned GPT-5 profile model + reasoning effort (as above).
AGENT_PROVIDER=openai
AGENT_API_KEY=sk-...

# Force ONE model for every skill (overrides the whole profile). If it is a
# reasoning model, also give it an effort so temperature is omitted:
# AGENT_MODEL=gpt-5.4-mini
# AGENT_REASONING_EFFORT=none

# Override a SINGLE skill — e.g. spend more reasoning on heading_structure, or
# route image_alt_text to a vision model on another gateway:
# AGENT_SKILL_HEADING_STRUCTURE_REASONING_EFFORT=medium
# AGENT_SKILL_IMAGE_ALT_TEXT_PROVIDER=openai-compatible
# AGENT_SKILL_IMAGE_ALT_TEXT_BASE_URL=https://openrouter.ai/api/v1
# AGENT_SKILL_IMAGE_ALT_TEXT_MODEL=meta-llama/llama-3.2-90b-vision-instruct
# AGENT_SKILL_IMAGE_ALT_TEXT_API_KEY=sk-or-...
```

Each finding records the model that produced it, so you can audit which model judged what. The other `AGENT_*` tuning knobs (concurrency, unit and token caps, timeout, image size, temperature) stay global — see [Configuration](#configuration).

**Cost.** `AGENT_MAX_UNITS_PER_SCAN` × `AGENT_MAX_TOKENS_PER_REQUEST` caps the output tokens of one attempt per unit. Actual spend can be higher: input tokens (screenshots, page text, prompts) are not capped, and the SDK may retry each request once. For a hard ceiling, use your provider's account-level limits.

The AI evaluation currently runs inside the scan job (the `analyzing` phase). A dedicated queue for large-scale async processing is a planned extension.

## API Reference

The OpenAPI 3 specification is generated from the code, so it never drifts from the implementation:

- **Interactive Swagger UI:** `http://localhost:3000/api` (while the server is running)
- **OpenAPI document:** `http://localhost:3000/api-json` (or `api-yaml`), and a committed copy at [`openapi.json`](openapi.json)

All endpoints are under `/v1` (for example `POST /v1/scans`). Errors follow [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json`.

The unauthenticated health probe is `GET /health`:

- `200` with `{ "status": "ok", "checks": { "database", "redis", "browserConnected", "queue" } }`
- `503` with `"status": "error"` when the database or Redis is down

## Use with mindfula11y (TYPO3)

The [mindfula11y](https://github.com/crinis/mindfula11y) TYPO3 extension sends scan requests to MindfulAPI and shows the results in the TYPO3 backend, so editors and integrators can fix accessibility issues without leaving the CMS.

Deploy MindfulAPI alongside TYPO3, then configure the extension with:

- the API base URL: `http://mindfulapi:3000` from inside the DDEV network, or `http://localhost:3000` from the host
- the auth token (`AUTH_TOKEN`)

For DDEV-based setups, see the network note below.

### Network note (DDEV / TYPO3 integration)

With [DDEV](https://ddev.readthedocs.io/) (a local development environment common for TYPO3), MindfulAPI can join the `ddev_default` Docker network and reach sites at `*.ddev.site` without extra routing.

**1. Add the included override file.** `docker-compose.ddev.yml` is an **override**: always combine it with the base `docker-compose.yml`. Either set `COMPOSE_FILE` in your shell (or in `.env`):

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.ddev.yml
docker compose up -d
```

Or pass both files:

```bash
docker compose -f docker-compose.yml -f docker-compose.ddev.yml up -d
```

**2. Accept DDEV's self-signed certificates** for `*.ddev.site` in `.env`:

```bash
IGNORE_HTTPS_ERRORS=true
```

**3. Allow your DDEV hostnames.** `*.ddev.site` resolves to a private address, which the SSRF policy blocks. List each hostname you want to scan, including additional site hostnames — wildcards such as `*.ddev.site` are not supported. The block stays active for every other address.

```bash
SCAN_TARGET_ALLOW_HOSTS=myproject.ddev.site
```

**Not using DDEV?** Use plain `docker compose` with only the base `docker-compose.yml`, and keep `IGNORE_HTTPS_ERRORS=false` (the default).

## Architecture

```
Client (TYPO3 / curl / etc.)
        │  POST /v1/scans
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
