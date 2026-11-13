# Direct conversion implementation — Task 1

Date: 2026-11-13. Branch: `feature/direct-file-conversion`. No commit created.

## Implemented behavior

- Replaced the homepage action-choice stage with one ordered in-memory queue. Every selection appends stable rows immediately, while local signature detection and the existing hook validation run asynchronously. Duplicate filenames retain separate identities. Removing a row prevents late detection from adding it back.
- Rows show name, size, detected input format, status, output selection, removal, per-file errors and result download. Image output options come from the existing server capability-backed image hook. Audio outputs come from its supported catalog intersected with server capabilities.
- Existing image/audio hooks remain responsible for local preflight, uploads, job options, idempotency, polling, expiry, cancellation/deletion and results. No alternate processing lifecycle or local image encoder was introduced.
- The audio hook now accepts either the existing single settings object or a per-entry settings resolver. Each entry resolves its own actual job options, idempotency serialization, output name and fallback result format. Both hooks accept optional target predicates without changing existing callers.
- An explicit homepage Konvertieren action snapshots selected eligible entries and dispatches image then audio batches, preserving the server concurrency bound. Completed rows with unchanged output are excluded from later starts; changing their output allows deliberate reconversion. Appending files preserves prior selections/downloads. Removing during a run uses the existing abort/delete path.
- Capability-dependent validation waits for the corresponding capability response, so smaller server byte and batch limits are applied before a start becomes available. The queue applies its combined cap across image/audio/PDF/unknown rows, with visible rejected rows and per-file explanations.
- Image compression/resizing and PDF compression remain available through the existing lazy same-page tools with the selected file. The main queue and both hooks stay mounted while that tool is open, and returning preserves selections/results. Back/forward navigation retains the same in-memory secondary-tool context.
- Removing the final row restores and focuses the original picker. The queue wraps long names and uses labeled native controls, live statuses and removal focus transfer.
- Existing comments were retained, with context added for the changed homepage flow. Files are not persisted in browser storage and no job POST occurs before explicit processing.

## Files

- `src/components/home/QuickStart.tsx`: persistent queue coordinator and row controls; retained secondary tools.
- `src/components/tools/useAudioBatch.ts`: compatible per-entry resolver and optional target predicate.
- `src/components/tools/useImageBatch.ts`: optional target predicate, keeping the existing resolver and server pipeline.
- `e2e/direct-conversion.spec.ts`: eight focused regressions using actual file signatures, native UI controls and API job-body assertions.
- This report. Existing `e2e/quickstart.spec.ts` was not edited by this task.

## Exact verification evidence

1. RED: `npx playwright test e2e/direct-conversion.spec.ts --project=chromium --workers=1` before product edits: **3 failed**, each because the expected `.file-row` queue was absent (received 0). This proved the original action-choice flow did not meet the regression.
2. First implementation run: 2 tests passed; one timed out because the new test queried capitalized `/Entfernen/` while the accessible row label used lowercase `entfernen`. Corrected the test to `/entfernen/i`; no product workaround.
3. Expanded focused run: **8 passed** (9.8s). Final run after per-file authoritative limit text and screenshot persistence: `npx playwright test e2e/direct-conversion.spec.ts --project=chromium --workers=1`: **8 passed** (10.1s), including its production build and preview server.
4. `npm run check`: **0 errors, 0 warnings, 0 hints** (126 files), repeated after the implementation and final limit/race changes.
5. `npx vitest run tests/unit/audio`: **15 browser test files passed, 78 tests passed**, covering Chromium, Firefox and WebKit audio checks/options/display/errors/signatures (9.18s).
6. `git diff --check`: exit 0, no whitespace errors. Git reports the repository's normal CRLF→LF normalization warning for QuickStart.

Focused browser coverage verifies:

- Two same-named WAV rows select MP3 and FLAC; actual multipart POST options and distinct download extensions agree.
- Append/remove retains remaining selections; later image processing preserves finished audio downloads without duplicate audio POSTs.
- Two images choose different formats and send those actual options; one server-side failure leaves successful neighboring downloads visible.
- Duplicate names with identical output formats receive unique result filenames.
- Mixed PDF/unknown/image rows remain visible, pre-start upload count stays zero, and PDF secondary-tool return preserves the image selection.
- Capability failure disables start with an explanation and retains visible rows.
- Delayed capabilities keep selected images checking; removal stays removed; a lower server batch cap and byte limit are honored before processing.
- At 390px and 1440px, long filenames cause no horizontal overflow. Screenshots are saved at `test-results/direct-conversion-queue-fits-390px-with-long-names-chromium/queue-390.png` and `test-results/direct-conversion-queue-fits-1440px-with-long-names-chromium/queue-1440.png`.

## Remaining acceptance work / limits

- Task 2 owns adaptation of the former action-choice tests, the full multi-browser/homepage suite, axe/theme/keyboard coverage, full unit/build checks and independent review.
- The delayed-capability regression covers removal while rows are checking. A dedicated browser-side delay of the signature read itself is appropriate additional Task 2 coverage for the initial detection race.
- PDF intentionally uses the permitted existing same-page secondary compressor rather than introducing a new PDF batch lifecycle. The main conversion queue/results remain mounted; PDF processing/results use the compressor's existing UI.
- API doubles verify the real frontend job contract and lifecycle, not backend transcoding quality.
