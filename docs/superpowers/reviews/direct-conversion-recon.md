# Direct conversion architecture reconnaissance

Date: 2026-11-13
Scope: read-only review of QuickStart, tool batch hooks/converters, and `2026-11-13-direkte-dateiauswahl-konvertierung.md`. No product code changed.

## Findings

- `QuickStart` currently has three phases: `select → choose → tool`. It classifies files in-browser, groups them by type, and then passes only one selected kind's files to one tool page through `initialFiles`. Mixed files therefore cannot stay in one workspace.
- `useInitialFiles` forwards the initial array once to the same `addFiles` callback used by the tool's dropzone. This is useful for preserving each tool's validation, but it is not a shared cross-tool list or per-file target interface.
- Image conversion already uses the server job pipeline. `useImageBatch.processAll` accepts either one `ProcessOptions` or a resolver `(entry: BatchEntry) => ProcessOptions`; it resolves options per entry, then creates/polls/deletes jobs and records each result. This is the narrowest path for per-image output choices. Image format availability comes from `support.encode` loaded from server capabilities.
- Audio conversion also uses the existing server job pipeline, but `useAudioBatch.processAll(settings)` applies one `AudioSettings` to every entry. Its options, idempotency key, output filename, and result fallback are currently computed once for the whole batch. Per-file targets require resolving those values inside the entry loop.
- `PdfCompressor` has its own one-file `file/job` state and submits all three compression levels as one job. It has no batch entry list or reusable processing hook. To show PDFs alongside image/audio rows and keep per-file status/results, extract its job lifecycle into a reusable PDF batch hook.
- `EntryList` / `EntryRow` can render generic image/audio entries and reuse removal focus behavior, but the homepage needs a shared row adapter for mixed entry types and target controls. PDF results have three downloads per file and need a specialized result renderer.
- The spec's statement that image processing is local is stale: current `useImageBatch` probes through `probeServerImage` and processes via `createJob` / `pollJob`. Preserve that existing server-backed path and the explicit-start upload boundary.

## Smallest robust architecture

Use one homepage coordinator with a single in-memory list. Classify each newly added file by signature using the existing `detectFileKind`; preserve insertion order and stable row IDs. Route recognized image and audio files into the existing hooks' `addFiles` methods so their established preflight checks, limits, statuses, result URLs, expiry handling, and cleanup remain authoritative. Keep unrecognized files as visible, non-processable coordinator rows. Forward PDF entries to a new `usePdfBatch` extracted from `PdfCompressor`.

Store each image/audio output selection by stable row ID (or as an optional selection field in the hook entry). Build one accessible row component that joins coordinator kind/order with hook-owned status/result data. The image and audio selects should read allowed outputs from their existing capability state and retain their values when more files are added. Show PDF's sole action as “PDF komprimieren”; do not present it as a format conversion.

One “Konvertieren” action can call the existing image and audio `processAll` methods with per-entry resolvers, plus the PDF hook's compression method. Keep selection/add/remove active-state rules and unknown/invalid per-file messages in the coordinator, while leaving processing and result state in the existing hooks. Enforce the configured max file count across the combined list, not once per hook. Since each hook independently caps workers using `maxActivePerSession`, dispatch types sequentially or provide one shared semaphore; blindly running all three hooks in parallel can exceed that per-session setting.

## Suggested interfaces and files

- `src/components/home/QuickStart.tsx`: replace the `choose/tool` screen transitions with add-to-list and direct workspace state; preserve its signature classifier and reset/focus behavior.
- `src/components/home/DirectConversionWorkspace.tsx` (new, or keep in QuickStart for a smaller diff): own ordered file rows, target selections, unknown rows, combined cap, one start button, and dispatch.
- `src/components/tools/useImageBatch.ts`: no process-loop change needed for target formats; expose supported target formats from the existing `support.encode` state to the coordinator if useful.
- `src/components/tools/useAudioBatch.ts`: allow `processAll(settings | ((entry: AudioEntry) => AudioSettings))`; resolve `buildAudioOptions`, serialized idempotency options, extension/name, and result-format fallback per entry. Keep the one-settings call compatible with `AudioConverter`.
- `src/components/tools/usePdfBatch.ts` (new): extract per-file capability/limit handling, job creation/polling/cancel/delete/expiry from `PdfCompressor`; retain the three-level job/result contract and existing single-file page behavior.
- `src/components/tools/DirectFileList.tsx` (new) or `FileList.tsx`: render kind/input format/size, an output select for image/audio or fixed compression action for PDF, status, error, remove, and type-specific result links. Keep controls labelled and use stable IDs.
- `src/lib/quickstart.ts`: reuse `detectFileKind`; current `classifyFiles/groupFiles` are group-oriented and lose the cross-type display order, so add a small per-file classification helper or consume `detectFileKind` directly when appending.

## Key acceptance risks for implementation

- Later file additions must merge into the same ordered list without resetting existing selections.
- A selected format must reach the per-entry server options and filename/result metadata; avoid converter defaults replacing it.
- Keep all valid rows processable when another row is unknown, invalid, or over-limit.
- The global list cap and cross-kind job concurrency must be enforced at coordinator level.
- Preserve explicit-start-only uploads, server-backed image/audio processing, and PDF's existing three-variant behavior.
