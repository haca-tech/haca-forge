# Storage Architecture & Bunny.net Integration

## 1. Overview & Architecture

The application uses an abstract storage adapter with two interchangeable drivers controlled by the `STORAGE_DRIVER` environment variable:

- **`local` (default in development):** Uploaded files are written directly to local disk under `apps/api/uploads/` and served via the `/uploads` static file route.
- **`bunny` (production):** Files are uploaded directly to Bunny.net Storage using Bunny's HTTP Storage API and served via a Bunny.net CDN Pull Zone protected with URL Token Authentication.

### Key Architectural Principles
- **Storage Keys in Database:** The database stores uniform storage keys (e.g., `uploads/2026/11/abc-123.mp4` or `uploads/avatars/user-456.webp`) rather than absolute URLs.
- **Backward Compatibility:** Existing records holding legacy `/uploads/...` paths automatically map to their respective keys (`uploads/...`) across all read operations.
- **Guarded Access:** Files are never publicly exposed. Every read request is evaluated against permission rules (Phase 3 workspace rules, Viewer restrictions, published work access, and chat participant rules) before a signed CDN URL or local redirect is issued.
- **Zero New Dependencies:** Storage drivers and migration utilities are implemented using native Node.js primitives (`fetch`, `crypto`, `fs`, and streams) without third-party SDKs.

---

## 2. Bunny.net Setup Steps

To configure Bunny.net for production hosting:

### Step 1: Create a Storage Zone
1. Log in to the [Bunny.net Dashboard](https://dash.bunny.net/).
2. Navigate to **Storage** and click **Add Storage Zone**.
3. Choose a storage zone name (e.g., `haca-marketing-storage`).
4. Select the main storage tier and region closest to your compute deployment (e.g., Frankfurt for EU or New York for US).
5. Once created, note the **Storage Zone Name**, **Storage Hostname** (e.g., `storage.bunnycdn.com` or `ny.storage.bunnycdn.com`), and the **Password / AccessKey** from the *FTP & API Access* tab.

### Step 2: Create a Pull Zone (CDN)
1. Go to **Pull Zones** and click **Add Pull Zone**.
2. Name your Pull Zone (e.g., `haca-marketing-cdn`).
3. Select **Storage Zone** as the origin type and choose the Storage Zone created in Step 1.
4. Select the desired pricing tiers/regions.
5. Note your CDN hostname (e.g., `https://haca-marketing-cdn.b-cdn.net`) or configure a custom domain (e.g., `https://cdn.haca.example.com`).

### Step 3: Enable URL Token Authentication
1. Open the Pull Zone settings and navigate to **Security** > **URL Token Authentication**.
2. Toggle **Token Authentication** to **Enabled**.
3. Set or generate a strong **Token Authentication Key**.
4. Save changes.

---

## 3. Environment Variables

When deploying with Bunny Storage (`STORAGE_DRIVER=bunny`), the following variables must be configured in `apps/api/.env` (and Render backend environment settings):

| Variable | Description | Example |
| :--- | :--- | :--- |
| `STORAGE_DRIVER` | Storage provider driver (`local` or `bunny`) | `bunny` |
| `BUNNY_STORAGE_ZONE` | Name of your Bunny Storage Zone | `haca-marketing-storage` |
| `BUNNY_STORAGE_HOST` | Hostname of the Bunny Storage API | `storage.bunnycdn.com` |
| `BUNNY_STORAGE_KEY` | Storage Zone API Access Key | `abc12345-6789-...` |
| `BUNNY_CDN_URL` | Base URL of the Pull Zone (with https://) | `https://haca-cdn.b-cdn.net` |
| `BUNNY_TOKEN_KEY` | Secret key used for URL Token Authentication | `sec_token_987...` |

### Startup Validation & Security
- If `STORAGE_DRIVER=bunny` and any required `BUNNY_*` variable is missing or blank, the API server fails to start immediately with a descriptive error message.
- Secret values (`BUNNY_STORAGE_KEY`, `BUNNY_TOKEN_KEY`) are masked and **never** printed to console logs or error reports.

---

## 4. How Signed URLs Work

Bunny.net URL token authentication guarantees that file links expire after a designated window and cannot be tampered with.

### Token Construction
The signed token is computed as:
$$\text{token} = \text{base64url}(\text{sha256}(\text{tokenKey} + \text{path} + \text{expires}))$$
Where:
- `tokenKey`: The secret token key configured on the Pull Zone.
- `path`: The absolute path of the resource (e.g., `/uploads/2026/11/abc.mp4`).
- `expires`: Unix epoch timestamp in seconds.

The final signed URL is:
```text
https://<BUNNY_CDN_URL>/<path>?token=<hash>&expires=<timestamp>
```

### Expiration Lifetimes
- **Work Files, Deliverables, Clips, Submissions & Attachments:** 10 minutes (`600 seconds`).
- **User Avatars:** 7 days (`604,800 seconds`).

### Authorization Enforcement
1. The client requests file access via API routes or requests a signed link via `POST /api/files/refresh`.
2. The server verifies session authentication, user role, and resource permissions.
3. If unauthorized, a `404 Not Found` or `403 Forbidden` response is returned immediately.
4. If authorized, the API generates and returns the short-lived signed Bunny CDN URL.

### Video Streaming & Range Requests
Bunny.net Pull Zones natively support HTTP byte-range requests (`Range: bytes=...`). Video players can seek smoothly through authenticated video URLs while token validity lasts.

### Web Client Integration
In `apps/web`:
- Components never construct file URLs directly.
- The `useFileUrl` hook / `refreshSignedUrl` helper (`apps/web/src/lib/fileUrls.ts`) fetches fresh signed URLs from `/api/files/refresh`.
- If an image, video, or download link encounters an expired token (HTTP 403), it automatically attempts a one-time refresh via the API.

---

## 5. Uploads, Streaming & File Lifecycle

### Upload Safety (Phase 4 Rules)
- Upload mime-types are strictly validated against an allowlist (images, videos, documents, audio).
- File extensions are server-enforced and mapped from validated mime-types.
- Unguessable storage keys are generated server-side.
- Proper `Content-Type` and `Content-Disposition` headers are supplied during upload so Bunny serves assets safely.

### Streaming Uploads
- Large uploads are streamed directly using Node.js readable streams piped to the HTTP PUT request sent to Bunny Storage.
- Files are not buffered in system memory, preventing heap exhaustion during concurrent large video uploads.

### Deletion & Cleanup
- When a clip, submission file, chat attachment, or replaced user avatar is deleted, the storage driver sends an HTTP `DELETE` to:
  `https://<BUNNY_STORAGE_HOST>/<BUNNY_STORAGE_ZONE>/<key>`
- Local file deletion logic remains identical when using the `local` driver.

---

## 6. Migration Script (`scripts/migrate-uploads-to-bunny.js`)

To migrate existing local uploads from local disk to Bunny Storage:

### Basic Commands
```bash
# Dry run (default): inspects files and database without writing anything
node scripts/migrate-uploads-to-bunny.js

# Live migration on local database:
node scripts/migrate-uploads-to-bunny.js --confirm --db-name=marketing_portal

# Live migration on remote/production MongoDB Atlas database:
node scripts/migrate-uploads-to-bunny.js --confirm --allow-remote --db-name=production_db
```

### Safety Features
- **Dry-run by default:** Does not upload files or modify database records without `--confirm`.
- **Remote DB Guard:** Refuses remote connection strings unless both `--allow-remote` and `--db-name=<matching_db>` are explicitly provided.
- **Idempotent:** Files already present in Bunny Storage with matching file sizes are skipped. Database records already holding storage keys are not altered.
- **Non-destructive:** Local files in `apps/api/uploads` are **never deleted** during migration.

---

## 7. Switching Back to Local Driver

To revert from Bunny Storage to local disk:
1. In `apps/api/.env`, set:
   ```env
   STORAGE_DRIVER=local
   ```
2. Restart the API server.
3. The API will immediately resume serving files from `apps/api/uploads/`.
4. Stored database keys (`uploads/...`) and legacy paths (`/uploads/...`) continue resolving through the local static route.
