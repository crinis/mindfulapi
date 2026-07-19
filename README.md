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
- **Optional AI audit** — opt-in LLM-agent skills that judge what axe-core cannot: image alt-text _quality_, plus heading, link, and form-label _semantics_ and page-title descriptiveness (up to WCAG AAA) — returned alongside the deterministic results ([details](#ai-accessibility-audit-optional))

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

### Container image tags

Images are published to `ghcr.io/crinis/mindfulapi` for AMD64 and ARM64. The
tags are channels with deliberately different stability guarantees:

| Tag | Meaning |
|---|---|
| `latest` | Newest stable release. Updated only by a stable SemVer Git tag, never by `main` or a prerelease. |
| `0.7.0` / `v0.7.0` | One exact release. The `v` form mirrors the Git tag; the unprefixed form follows container-version conventions. |
| `0.7` | Newest stable patch release in that minor line. |
| `1` | Newest stable release in that major line. A broad `0` tag is intentionally not published because pre-1.0 releases may be incompatible. |
| `dev` | Newest successful build from `main`. This is unreleased and may be unstable. |
| `sha-abcdef0` | Build from one exact Git commit. |

Prerelease tags such as `v0.8.0-rc.1` publish only their exact version tags and
never update `latest`, `0.8`, or a major-version tag. For reproducible
deployments, pin an exact version or the image digest; moving tags such as
`latest`, `0.7`, and `dev` are intended to receive updates.

The Compose file defaults to `latest`. Select another channel in `.env`, for
example:

```bash
MINDFULAPI_IMAGE=ghcr.io/crinis/mindfulapi:0.7.0
```

Then pull and recreate the service normally:

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

**`*.ddev.site` resolves to a private address, which the SSRF policy blocks.** List the specific DDEV hostname(s) you want to scan in `SCAN_TARGET_ALLOW_HOSTS` (the override passes this through) so only those are exempted — the per-request block stays active for every other address:

```bash
SCAN_TARGET_ALLOW_HOSTS=myproject.ddev.site
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
| `AGENT_ENABLED` | `false` | Enable the optional [AI accessibility audit](#ai-accessibility-audit-optional) |
| `AGENT_PROVIDER` | _(unset)_ | LLM provider: `openai`, `anthropic`, or `openai-compatible` (OpenRouter / local models) |
| `AGENT_MODEL` | _(unset)_ | Model for every skill. Optional for OpenAI (unset → tuned [per-skill profile](#picking-a-model)); required for other providers |
| `AGENT_API_KEY` | _(unset)_ | Provider API key; validated lazily, never logged |
| `AGENT_BASE_URL` | _(unset)_ | Base URL for the `openai-compatible` provider (OpenRouter or a local server) |
| `AGENT_SKILLS` | `image_alt_text,heading_structure,link_purpose,form_labels,page_title` | Comma-separated skills clients may request |
| `AGENT_ALLOWED_SCAN_MODES` | `single_url` | Comma-separated scan modes for which clients may request an AI audit: `single_url`, `url_list`, `crawl` |
| `AGENT_REASONING_EFFORT` | _(unset)_ | Reasoning effort (`none`…`high`) when `AGENT_MODEL` is a reasoning model; the profile sets this per skill otherwise. Note: `gpt-5.4+` reject `minimal` — use `none`; only the original `gpt-5-nano`/`gpt-5-mini` accept `minimal` |
| `AGENT_SKILL_<ID>_{PROVIDER,MODEL,API_KEY,BASE_URL,REASONING_EFFORT}` | _(inherits `AGENT_*` / profile)_ | Optional per-skill override (e.g. `AGENT_SKILL_HEADING_STRUCTURE_REASONING_EFFORT`). See [Per-skill model selection](#per-skill-model-selection) |
| `AGENT_CONCURRENCY` | `4` | Concurrent per-unit requests during evaluation — one unit is an image (`image_alt_text`) or a page (the text-only skills) (1–16) |
| `AGENT_MAX_UNITS_PER_PAGE` | `30` | Cap on collected work units per page |
| `AGENT_MAX_UNITS_PER_SCAN` | `200` | Cap on evaluated work units per scan. This times `AGENT_MAX_TOKENS_PER_REQUEST` is the per-scan output-token ceiling |
| `AGENT_MAX_TOKENS_PER_REQUEST` | `2000` | Output-token cap per request (covers reasoning tokens) |
| `AGENT_REQUEST_TIMEOUT_MS` | `60000` | Per-request timeout |
| `AGENT_MAX_IMAGE_BYTES` | `1500000` | Skip element screenshots larger than this |
| `AGENT_TEMPERATURE` | `0` | Sampling temperature (0–2); omitted for reasoning models |

Generate a secure encryption key (required when using encrypted fields such as `scanOptions.basicAuth`):

```bash
openssl rand -base64 32
```

---

## Security

- **Authentication is required by default.** The server will not start unless `AUTH_TOKEN` is set (or `AUTH_DISABLED=true` is set explicitly). Tokens are compared in constant time.
- **SSRF protection.** Hosts that resolve to private or reserved network ranges (loopback, RFC 1918, link-local/cloud-metadata `169.254.169.254`, CGNAT, ULA, etc.) are blocked — and the block is enforced on **every** browser request, not just the submitted target: the initial navigation, any redirect it follows, and every subresource (image, script, iframe) the page loads are each checked, so a permitted public page cannot pivot to an internal address. To scan intranet/staging sites, set `SCAN_ALLOW_PRIVATE_TARGETS=true` (only when the API is not exposed to untrusted clients) or allow specific hosts with `SCAN_TARGET_ALLOW_HOSTS`. Note: the policy resolves hosts independently of the browser's own DNS resolution, so a DNS-rebinding attacker with a very low TTL could still flip a record between the check and the fetch — acceptable for a self-hosted tool, but keep the API access-controlled.
- **Rate limiting** is applied globally (`THROTTLE_TTL` / `THROTTLE_LIMIT`); the `/health` probe is exempt.
- **Runs as a non-root user.** The container process runs as the unprivileged `node` user (uid 1000), so the mounted `/data` volume must be writable by it. Fresh installs handle this automatically; upgrading from an older image that ran as root needs a one-time `chown` (see [Updating](#updating)).
- **Single replica.** SQLite and the in-process cleanup schedule assume exactly one API instance. Scale scan throughput with `SCAN_CONCURRENCY`, not by running multiple replicas. Back up the `/data` volume before upgrading, since the schema is auto-synced (no migrations).

---

## AI accessibility audit (optional)

Axe-core is deterministic: it can tell that an image _has_ an `alt` attribute, but not whether that text is _accurate, meaningful, or correctly decorative_. The optional AI audit adds LLM-agent **skills** that make exactly those judgments and returns them **alongside** the axe results — never replacing them.

The feature is **disabled by default**. When enabled server-side, each scan still opts in per request; by default it runs every server-enabled skill, while clients may request a subset. Agent use is restricted to `single_url` scans by default. Operators can allow additional modes with `AGENT_ALLOWED_SCAN_MODES=single_url,url_list,crawl`.

### How it works

- **Deterministic-first triggering.** A skill only evaluates what axe cannot, so there is no duplicate reporting and no wasted tokens. `image_alt_text` ignores any image axe already flags for a missing name; `heading_structure` never reports skipped levels, empty headings, or a missing `<h1>` (all covered by axe); `link_purpose` only judges links that already have a name and skips identical-name/different-target links (axe's `identical-links-same-purpose`); `form_labels` only judges the clarity of a control's label and instructions (2.4.6 / 3.3.2), never re-reporting missing/title-only/multiple labels (axe's) or anything an attribute/structure check settles deterministically (required state, placeholder-as-label, grouping, autocomplete); `page_title` only judges whether a *present* `<title>` describes the page (2.4.2) and never reports a missing/empty title (axe's `document-title`) — each judges only _semantics_.
- **Minimal, structured evidence.** Evidence is gathered while the page is live and kept as small as possible. `image_alt_text` sends a cropped element screenshot plus accessible-name attributes, one request per image. `heading_structure` sends the page's heading outline (levels, text, a short content snippet each) plus styled-block and unheaded-section candidates as text — one request per page, no screenshot. `link_purpose` sends a deduplicated inventory of named links (accessible name, compact destination, surrounding context) — repeated nav/footer links collapse to a single line — again one text-only request per page. `form_labels` sends the page's form controls (accessible name + its source, control type, placeholder, existing described-by instructions, constraint hints) — one text-only request per page. `page_title` sends the page's `<title>` plus its top headings and meta description as topic context — one text-only request per page.
- **Forced structured output.** Every request returns a fixed verdict with a confidence score, and each finding records the WCAG success criterion it maps to. Low-confidence or unjudgeable cases become `insufficient_evidence` findings flagged for human review — the model never fabricates a verdict.
- **New lifecycle status.** With AI audit requested, a scan progresses `pending → running` (axe) `→ analyzing` (agents) `→ completed`. Clients must tolerate the new `analyzing` status.

### Skills

| Skill | Granularity | Judges (WCAG) | Axe already covers (not re-reported) |
| --- | --- | --- | --- |
| `image_alt_text` | per image (vision) | Accuracy / redundancy / decorative correctness of an _existing_ accessible name (1.1.1) | Missing alt / accessible name |
| `heading_structure` | per page (text-only) | Non-descriptive & vague/generic headings, confusing duplicates, `h1`↔topic mismatch (2.4.6); content sections with no heading (**2.4.10, AAA**); headings faked with styled `<p>`/`<div>` (1.3.1) | Skipped/out-of-order levels, empty headings, missing `<h1>` |
| `link_purpose` | per page (text-only) | Generic filler / non-descriptive / raw-URL link text (2.4.4, A); link names that only make sense with surrounding context (**2.4.9, AAA**) | Missing link name, identical names pointing to different destinations |
| `form_labels` | per page (text-only) | Uninformative or ambiguous field labels (2.4.6); fields needing format/constraint instructions the user is never given (3.3.2) | Missing / title-only / multiple labels, missing button & select names (plus deterministic facts left to future checks: required state, placeholder-as-label, control grouping, autocomplete tokens) |
| `page_title` | per page (text-only) | Placeholder/boilerplate page titles ("Untitled Document", "Home") or titles that don't describe the page (2.4.2, A) | Missing / empty `<title>` (axe's `document-title`); cross-page title uniqueness left to a future deterministic check |

`heading_structure`, `link_purpose`, `form_labels`, and `page_title` cover the judgment-based criteria (2.4.6 / 2.4.10 / 1.3.1 for headings; 2.4.4 / 2.4.9 for links; 2.4.6 / 3.3.2 for form labels; 2.4.2 for the page title) that deterministic tooling structurally cannot evaluate — including the Level **AAA** heading and link criteria (2.4.10 / 2.4.9). Each skill owns a single semantic task and never judges anything an attribute or structure check could settle deterministically. `page_title` is deliberately **SEO-safe**: it never flags a title for containing the site/brand name, its length, or its keywords, and any suggested fix keeps the brand and adds the missing page topic.

### Requesting an audit

```jsonc
POST /v1/scans
{
  "mode": "single_url",
  "url": "https://example.com",
  "aiAudit": {}
}
```

Omitting `skills` runs every skill enabled by the server's `AGENT_SKILLS` setting. Clients may still provide an explicit list to request a subset. Scan responses gain an `aiAudit` summary (`status`, `requestedSkills`, task counters) and an `agentFindings` array; list summaries gain `agentFindingCount`. Requesting the audit when it is disabled server-side, for a mode excluded by `AGENT_ALLOWED_SCAN_MODES`, or with a non-whitelisted skill returns a `400` problem. Deployments that need the previous all-mode behavior must explicitly set `AGENT_ALLOWED_SCAN_MODES=single_url,url_list,crawl`.

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
| `details` | Skill-specific extras (e.g. `currentAlt`, `suggestedLevel`) |
| `model` | Provenance — the model that produced the finding |

### Choosing an API/gateway and model

Configuration is entirely environment-variable driven (the same convention as the rest of MindfulAPI — there is no separate config file). The harness is built on the Vercel AI SDK, so one set of variables reaches many providers. You pick **where** requests go with `AGENT_PROVIDER` (+ `AGENT_BASE_URL`), and **which model** with `AGENT_MODEL` — though for OpenAI you can leave `AGENT_MODEL` unset and get the tuned [per-skill profile](#picking-a-model) instead:

| Goal | `AGENT_PROVIDER` | `AGENT_BASE_URL` | `AGENT_MODEL` (example) |
|------|------------------|------------------|-------------------------|
| OpenAI directly | `openai` | _(unset)_ | _(unset → tuned GPT-5 per-skill profile)_ or e.g. `gpt-5.4-mini` |
| Anthropic directly | `anthropic` | _(unset)_ | `claude-3-5-haiku-latest` |
| **OpenRouter** (one key → hundreds of models) | `openai-compatible` | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`, `meta-llama/llama-3.2-90b-vision-instruct` |
| DeepSeek | `openai-compatible` | `https://api.deepseek.com` | `deepseek-chat` |
| **Local** (Ollama) | `openai-compatible` | `http://localhost:11434/v1` | `llama3.2-vision` |
| **Local** (vLLM / LM Studio) | `openai-compatible` | `http://localhost:8000/v1` | _(the served model id)_ |

```bash
AGENT_ENABLED=true
AGENT_PROVIDER=openai-compatible
AGENT_BASE_URL=https://openrouter.ai/api/v1
AGENT_MODEL=openai/gpt-4o-mini
AGENT_API_KEY=sk-or-...
AGENT_SKILLS=image_alt_text,heading_structure,link_purpose,form_labels,page_title   # skills available to audit requests
```

**Picking a model.** Each skill has different needs, so rather than forcing one model everywhere the server ships a **tuned per-provider profile**: select a provider, leave `AGENT_MODEL` unset, and every skill automatically runs on the model — and reasoning effort — that tested best for it, no per-skill config required. The profile targets OpenAI's current **GPT-5 line** (the gpt-4.x family is now legacy). These are reasoning models, so each entry pairs a model with a **reasoning effort**; the profile comes from per-skill A/B testing, chosen for accuracy **without over-flagging** (a false "issue" on a clean page erodes trust as much as a miss):

| Skill | OpenAI profile | Effort | Why |
| --- | --- | --- | --- |
| `image_alt_text` | `gpt-5.4-mini` | `none` | Needs a **vision** model; reads the screenshot and judges accurately |
| `heading_structure` | `gpt-5.4-mini` | `low` | Multi-verdict structural reasoning; the reasoning pass is the only config with full recall **and** zero false positives (9/9). `none`-effort tiers over-flag clean pages |
| `form_labels` | `gpt-5.4-nano` | `none` | GPT-5's reasoning-native nano now catches the descriptiveness/instruction gaps the legacy nano missed entirely — no need for `mini` |
| `link_purpose` | `gpt-5.4-nano` | `none` | Simple text classification; nano matched the larger models |
| `page_title` | `gpt-5.4-nano` | `none` | Simple title-vs-content check; nano matched the larger models |

The rule the testing confirmed: a weak model/effort fails by *under-reporting* (false "appropriate") or *over-reporting* on clean pages — both easy to miss — so the profile spends the extra reasoning only where the cheap setting measurably failed (`heading_structure`). Reasoning models reject a non-default temperature, so the harness **omits `temperature`** and passes the reasoning effort for any profiled/reasoning model automatically. The harness validates every response and falls back to `insufficient_evidence` on hard failures, so a scan never breaks.

Only OpenAI ships a profile today. Providers without one (Anthropic, `openai-compatible` gateways like OpenRouter/DeepSeek/local) require an explicit `AGENT_MODEL`; adding a profile for them is a one-object change in `src/config/configuration.ts`.

### Per-skill model selection

**Model precedence, highest first:** `AGENT_SKILL_<ID>_MODEL` (explicit per-skill) → `AGENT_MODEL` (explicit global — forces one model for every skill) → the provider profile above. The reasoning effort follows the same source: `AGENT_SKILL_<ID>_REASONING_EFFORT` → `AGENT_REASONING_EFFORT` (global) → the profile's effort (only when the profile also supplied the model). So you only set env for what you want to change; the profile fills in the rest. The other per-skill fields — `AGENT_SKILL_<ID>_{PROVIDER,API_KEY,BASE_URL}` — let a single skill run on an entirely different gateway (each independently falls back to the corresponding `AGENT_*` default).

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

The `<SKILL_ID>` is the upper-cased skill value (e.g. `image_alt_text` → `IMAGE_ALT_TEXT`, `page_title` → `PAGE_TITLE`). Each finding records the model that actually produced it, so you can audit which model judged what. (Non-model tuning knobs like the token/unit caps below remain global.)

Cost/behaviour controls (all optional, global): `AGENT_CONCURRENCY`, `AGENT_MAX_UNITS_PER_PAGE`, `AGENT_MAX_UNITS_PER_SCAN`, `AGENT_MAX_TOKENS_PER_REQUEST`, `AGENT_REQUEST_TIMEOUT_MS`, `AGENT_MAX_IMAGE_BYTES`, `AGENT_TEMPERATURE`. Per-scan spend is bounded by `AGENT_MAX_UNITS_PER_SCAN` × `AGENT_MAX_TOKENS_PER_REQUEST`; use your provider's account-level limits for a hard cost ceiling. See [`.env.example`](.env.example) for defaults.

> **Privacy.** When the AI audit runs, cropped element screenshots and the associated attributes are sent to the configured LLM provider. Only enable it with a provider you trust, and consider a self-hosted/local model for sensitive sites.

> **Model quality varies.** "Supports many models" is about reach, not guarantees — weaker models produce weaker structured output. The harness validates every response and falls back to `insufficient_evidence` rather than failing a scan, but pick a capable vision model for accuracy.

The AI evaluation currently runs inside the scan job (the `analyzing` phase). Moving it to a dedicated queue for large-scale async processing is a planned extension.

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

New: `DELETE /v1/scans/:id`, `POST /v1/scans/:id/cancel`, `GET /health`, response caching on rules/reports, and rate limiting. The [optional AI audit](#ai-accessibility-audit-optional) adds an `aiAudit` request field, `aiAudit`/`agentFindings` response fields, and a new `analyzing` scan status — all additive, but clients must tolerate the new status value and fields.

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

**Upgrading from an image that ran as root.** The container now runs as the
unprivileged `node` user (uid 1000). If your `/data` volume was created by an
older image that ran as root, the new container cannot write it and SQLite fails
on startup with *"attempt to write a readonly database"*. Fix the ownership once
(the one-off container mounts the same volume and re-owns it to `node`):

```bash
docker compose down
docker compose run --rm --no-deps --user root --entrypoint sh mindfulapi \
  -c 'chown -R node:node /data'
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
