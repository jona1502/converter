# Runtime diagnosis — 2026-11-03

Scope: read-only investigation of the earlier `npm test` timeout, installed browser runtimes, and Docker availability. No source/configuration changes, dependency installs, container changes, or commits were made. The only repository write is this report.

## Vitest result

The earlier two-minute hang did **not reproduce**. A complete bounded run passed on the existing configuration:

```powershell
node node_modules/vitest/vitest.mjs run --reporter=verbose
```

This is the underlying runner used by `npm test` (`vitest run`). It was launched by a small Node diagnostic wrapper with a 60,000 ms deadline. On timeout the wrapper would kill only its own spawned runner process tree; the deadline was not reached and no process was killed.

- Exit code: **0**.
- Test files: **42 passed / 42** (14 files across Chromium, Firefox, WebKit).
- Tests: **410 passed, 10 skipped / 420**.
- Vitest duration: **51.16 seconds**; wrapper wall time: **52.951 seconds**.
- Verbose output showed continuous progress across all three engines, including image workers, PDF workers, encoding, stream limits, abort/restart handling, and PDF fixtures.
- The observed skips follow existing browser capability guards. WebKit on Windows exercises the unsupported-OffscreenCanvas path and skips five PDF worker recompression cases. The absent-feature case itself passes.

Configuration evidence: `vitest.config.ts` enables headless Playwright browser execution, registers Chromium/Firefox/WebKit, and sets `fileParallelism: false` intentionally because image/PDF fixtures consume memory. PDF tests also contain explicit 60 s test and 120 s fixture limits for expensive generated fixtures. In this run all encrypted fixture cases completed below one second; no fixture timeout occurred.

Observed environment:

| Check | Result |
| --- | --- |
| `node --version` | `v25.8.2`, exit 0 |
| `npm --version` | `11.18.0`, exit 0 |
| `npm ls vitest @vitest/browser-playwright playwright --depth=0` | Vitest/browser provider `5.0.5`, Playwright `1.64.1`, exit 0 |
| Independent Playwright Chromium launch + local data-page title | Pass, 195 ms |
| Independent Playwright Firefox launch + local data-page title | Pass, 1471 ms |
| Independent Playwright WebKit launch + local data-page title | Pass, 222 ms |

The launch probe used each installed Playwright browser with `{ headless: true, timeout: 15000 }`, opened `data:text/html,<title>probe</title>`, asserted the returned title by printing it, and closed its own browser. Overall exit 0. Resolved revisions are Chromium 1248, Firefox 1555, WebKit 2370.

**Cause assessment:** no present runner/configuration defect or missing-browser mechanism is supported by the evidence. The precise historical timeout cause remains unproven without its process/output trace. A serial, three-browser fixture suite does have substantial normal runtime; an external two-minute timeout by itself cannot establish a deadlock. No product/configuration fix is warranted from this reproduction. For future diagnosis use verbose output and a bounded run; if a timeout recurs, capture the last completed test, browser, elapsed time, and child process state before proposing a change.

## Docker result

Initial `docker version` printed Docker client `29.8.2`, but failed to connect to `npipe:////./pipe/dockerDesktopLinuxEngine` because that named pipe did not exist. No Docker processes were initially listed. The active context was already `desktop-linux`.

Started the installed Docker Desktop runtime as authorized:

```powershell
Start-Process -FilePath 'C:/Program Files/Docker/Docker/Docker Desktop.exe' -WindowStyle Hidden
```

Then:

| Command | Result |
| --- | --- |
| `docker version` | Exit 0; Desktop `4.95.0 (242831)`, Engine `29.8.2`, Linux/amd64 |
| `wsl --status` | Exit 0; WSL 2, default distribution `kali-linux` |
| `docker compose -f server/compose.test.yaml config --quiet` | Exit 0 |
| `docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}'` | Exit 0; required pinned PostgreSQL, Valkey, and Go images already cached |
| `docker ps --format '{{.Names}} {{.Status}}'` | Exit 0; existing converter web/API/worker/cleanup containers had automatically resumed |

**Confirmed Docker cause:** the Linux daemon was stopped; installation and CLI/context were present. Starting Docker Desktop resolved API connectivity. No daemon settings, context, volumes, Compose services, or images were changed. Docker's existing restart policies automatically resumed `mi-converter` containers after daemon startup; this was reported to the coordinator. They were left untouched.

Linux backend verification is now unblocked at the runtime level. The dedicated `server/compose.test.yaml` declares an isolated test project with tmpfs database storage, so the coordinator's backend verification agent can use its documented test commands. This diagnostic did not run backend container tests and makes no claim about them. Native Windows Go path behavior remains a platform-specific limitation until checked in the Linux test environment.
