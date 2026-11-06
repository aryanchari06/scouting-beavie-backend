# Scouting Beavie: Backend Documentation

Serverless backend for the Scouting Beavie Chrome extension. It parses resume PDFs, scores resume-to-job fit with an LLM, and enforces per-day usage limits without any user accounts.

> **Status:** Deployed and verified end to end (IAM, rate limiting, TTL, budget alerts). Items marked `TODO` need to be filled in from source I haven't documented yet.

---

## 1. Architecture

```
Chrome extension
      |  HTTPS + x-install-id header
      v
Lambda Function URLs (AuthType NONE)
      |-- HealthFunction          GET  /
      |-- ParsePDFFunction        POST /parse-pdf
      |-- MatchJobProfileFunction POST /match-job-profile
      |
      +--> DynamoDB: beavie-ratelimit   (daily counters, TTL)
      +--> DynamoDB: beavie-installs    (registered install IDs)
      +--> Amazon Bedrock               (match-job-profile only)
```

| Item | Value |
|---|---|
| Framework | AWS SAM (CloudFormation) |
| Stack name | `scouting-beaver` |
| Runtime | Node.js 24.x, x86_64 |
| Region | `ap-south-1` |
| Auth | None. Anonymous install ID plus IP-based limits |
| Always-on servers | None. Pay per request |

---

## 2. Functions

| Function | Handler | Memory | Timeout | Purpose |
|---|---|---|---|---|
| `HealthFunction` | `handlers/health/app.handler` | 512 MB | 30 s | Health check |
| `ParsePDFFunction` | `handlers/parse-pdf/app.handler` | 1024 MB | 30 s | Extract text from a resume PDF |
| `MatchJobProfileFunction` | `handlers/match-job-profile/app.handler` | 256 MB | 40 s | Score resume against a job using Bedrock |

All three use `CodeUri: src` and JSON logging.

### Environment variables

| Function | Variable | Description |
|---|---|---|
| `MatchJobProfileFunction` | `AGENT_MODEL_ID` | Bedrock model ID or inference profile ID, set from the `ModelId` template parameter |

---

## 3. API reference

All protected endpoints require the header `x-install-id` (non-empty string, max 128 characters).

### 3.1 `POST /parse-pdf`

Request: raw PDF bytes as the body (Function URL delivers it base64-encoded).

Processing order:

1. Method must be `POST` (else 405) and path must be `/parse-pdf` (else 404).
2. Body must exist and be base64-encoded (else 400).
3. Encoded length must be under the limit (else 413).
4. Decoded bytes must start with `%PDF` (else 415).
5. **Rate limit check** (else 429, or 400/500 for bad ID or backend failure).
6. Load PDF and reject more than 2 pages (422).
7. Extract text with `unpdf`. Reject empty text (422) or text over 100,000 characters (422).
8. Register the install ID in `beavie-installs` (500 on failure).
9. Return `200 { "data": { "text": "..." } }`.

Limits:

| Rule | Value |
|---|---|
| Max file size | 5 MB |
| Max pages | 2 |
| Max extracted text | 100,000 characters |

Response codes:

| Status | Meaning |
|---|---|
| 200 | Text extracted |
| 400 | Missing body or invalid install ID |
| 405 | Wrong method |
| 404 | Wrong path |
| 413 | File too large |
| 415 | Not a PDF |
| 422 | Too many pages, no readable text, text too large, or unreadable PDF |
| 429 | Daily quota exceeded |
| 500 | Rate limiter or install registry failure |

The install ID is registered only after a successful parse, so failed uploads don't create registry rows.

### 3.2 `POST /match-job-profile`

Scores a resume against a job using Bedrock.

- Requires a registered install ID (registered by a successful `/parse-pdf`). Unknown IDs are rejected. `TODO`: confirm status code and message in source.
- Request body: `TODO`
- Success response: `TODO`
- Prompt and output schema: `TODO`

### 3.3 `GET /` (health)

`TODO`: document the response shape.

---

## 4. Rate limiting

Implemented in `utils/rate-limit.js` as `withRateLimit(event)`. It returns `null` when the request is allowed, or a failure object `{ statusCode, code, message, retryable }`.

### Limits per UTC day

| Endpoint | Per install ID | Per IP |
|---|---|---|
| `/parse-pdf` | 10 | 50 |
| `/match-job-profile` | 3 | 10 |

### How it works

Each request atomically increments two counters in `beavie-ratelimit` with a single `TransactWriteCommand`:

- IP counter
- Install ID counter

Each item uses:

```
UpdateExpression:    SET #count = if_not_exists(#count, :zero) + :one, #exp = :exp
ConditionExpression: attribute_not_exists(#count) OR #count < :limit
```

If either condition fails, the whole transaction is cancelled. This means a request blocked by one limit does not consume the other's quota.

Key format:

```
scope:<ip|installId>::value:<value>::endpoint:<parse_pdf|match_job_profile>#<YYYY-MM-DD>
```

Because the date is part of the key, each day starts with fresh counters.

### Failure codes

| Code | HTTP | Cause |
|---|---|---|
| `NOT_FOUND` | 404 | Path not in allowed list |
| `CLIENT_IP_UNAVAILABLE` | 500 | No source IP on the request |
| `INSTALL_ID_INVALID` | 400 | Missing, blank, or longer than 128 characters |
| `RATE_LIMIT_EXCEEDED` | 429 | A counter hit its limit |
| `RATE_LIMIT_ERROR` | 500 (retryable) | Unexpected error, such as a DynamoDB or IAM problem |

The limiter fails closed: if DynamoDB is unavailable, requests are blocked rather than allowed through.

### Changing limits

Edit `getMaxLimit(path, scope)` in `utils/rate-limit.js`. To add an endpoint, add it to `allowedPaths` as well.

---

## 5. Data stores

### `beavie-ratelimit`

| Attribute | Type | Notes |
|---|---|---|
| `pk` | String (partition key) | Key format in section 4 |
| `count` | Number | Requests so far today |
| `expiresAt` | Number | Epoch seconds, now plus 2 days |

**TTL is enabled on `expiresAt`.** DynamoDB deletes expired rows on its own, usually within about 48 hours of expiry. Rows created before TTL was added have no `expiresAt` and won't expire. They are tiny and can be deleted by hand.

### `beavie-installs`

| Attribute | Type | Notes |
|---|---|---|
| `pk` | String (partition key) | Install ID |
| `createdAt` | String | ISO timestamp, set once |
| `lastSeenAt` | String | ISO timestamp, updated on each successful parse |

TTL is **not** enabled on this table, since it is the registry of valid installs.

---

## 6. Security and IAM

Least-privilege policies per function (in `template.yaml`):

| Function | Permissions |
|---|---|
| `ParsePDFFunction` | `dynamodb:UpdateItem` on `beavie-ratelimit` and `beavie-installs` |
| `MatchJobProfileFunction` | `dynamodb:UpdateItem` on `beavie-ratelimit`, `dynamodb:GetItem` on `beavie-installs`, `bedrock:InvokeModel` on `*` |

Important: `dynamodb:TransactWriteItems` is **not** an IAM action. DynamoDB authorizes each `Update` inside a transaction as `dynamodb:UpdateItem`, so that is the permission to grant. Putting `TransactWriteItems` in a policy grants nothing and causes `AccessDeniedException` at runtime.

Current exposure:

- **Function URLs are public** (`AuthType: NONE`). Abuse protection comes from the rate limits, not from authentication.
- **CORS allows any origin (`*`).** Lock this to `chrome-extension://<extension-id>` once the Web Store assigns the ID.
- **`bedrock:InvokeModel` uses `Resource: '*'`.** Scope it to the model or inference profile ARN.

---

## 7. Cost controls

| Control | Status |
|---|---|
| Per-IP and per-install daily limits | Active |
| AWS Budget, $5 per month, email alerts at 80% actual and 100% forecasted | Active (created in console) |
| Lambda reserved concurrency | Not set. The account's concurrency quota is too low for it. Request a quota increase, then add it back |
| Global daily cap on total requests | Not implemented. Optional DynamoDB counter, or API Gateway usage plan |
| CloudWatch alarm on `MatchJobProfileFunction` invocations | `TODO` (recommended) |

Notes:

- Budgets alert by email only. They do not stop spending, and billing data lags by hours.
- The account-wide Lambda concurrency limit still bounds total simultaneous executions.

---

## 8. Deployment

Prerequisites: AWS CLI configured, AWS SAM CLI, Node.js.

```bash
cd scouting-beaver-backend
sam build
sam deploy
```

First deploy needs a guided run to save settings:

```bash
sam deploy --guided
```

You will be asked for the `ModelId` parameter (Bedrock model ID or inference profile ID).

Stack outputs after deploy:

- `HealthUrl`
- `ParsePdfUrl`
- `MatchJobProfileUrl`

Copy the last two into the extension's config.

One-time setup (already done):

```bash
aws dynamodb update-time-to-live \
  --table-name beavie-ratelimit \
  --time-to-live-specification "Enabled=true,AttributeName=expiresAt" \
  --region ap-south-1
```

### Rollbacks

A failed deploy rolls back automatically. If a stack ends in `UPDATE_ROLLBACK_COMPLETE`, it is back in its previous working state. Fix the cause and deploy again. Past example: setting `ReservedConcurrentExecutions` failed because AWS requires at least 10 unreserved concurrent executions in the account.

---

## 9. Monitoring and troubleshooting

Logs go to CloudWatch Logs in JSON format, one log group per function.

| Symptom | Likely cause |
|---|---|
| `AccessDeniedException ... dynamodb:UpdateItem` | IAM policy missing `dynamodb:UpdateItem` on the table |
| 500 `RATE_LIMIT_ERROR` | DynamoDB or IAM problem. Check the `Rate limit error:` log line |
| 500 "Could not register this installation" | Missing `UpdateItem` permission on `beavie-installs` |
| 429 for a new user | Shared IP (office, college, mobile carrier) hit the per-IP limit |
| 413 on a normal PDF | Size limit constant is wrong. See known issues |
| 422 "No readable text found" | Scanned or image-only PDF (no OCR) |

---

## 10. Known issues and follow-ups

1. **Size limit constant.** `MAX_ENCODED_LENGTH = Math.ceil(MAX_PDF_BYTES * 4) / 3` divides outside `Math.ceil`. The intended form is `Math.ceil(MAX_PDF_BYTES / 3) * 4`. Verify it in source.
2. **Quota is consumed before page and text checks.** A rejected PDF (3 pages, no text) still counts toward the install's 10 per day.
3. **Redundant install ID check** in the `/parse-pdf` handler. The rate limiter already rejects missing or invalid IDs.
4. **Per-install quota resets on reinstall**, and fake install IDs are possible. Per-IP limits and the budget bound the worst case.
5. **Planned:** lock CORS to the extension ID, scope the Bedrock ARN, add reserved concurrency after a quota increase, add a CloudWatch alarm on invocations, and optionally add a global daily cap.

---

## 11. Project layout

`TODO`: confirm against the actual repo.

```
scouting-beaver-backend/
├── template.yaml
├── samconfig.toml
└── src/
    ├── handlers/
    │   ├── health/app.mjs
    │   ├── parse-pdf/app.mjs
    │   └── match-job-profile/app.mjs
    └── utils/
        ├── http-response.mjs
        ├── rate-limit.js
        ├── install-registry.js
        └── dynamo-db.js
```
