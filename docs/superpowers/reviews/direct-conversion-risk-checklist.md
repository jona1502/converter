# Direct conversion pre-implementation risk checklist

Purpose: concrete edge cases for the homepage coordinator, checked against the existing batch hooks and API lifecycle. This is a pre-implementation checklist, not a code review. No product code changed.

## Classification and queue races

- [ ] Select two batches quickly while signature reads are pending. Both batches must be appended; an older classification result must not be discarded as stale or overwrite the newer list.
- [ ] Preserve selection order across image/audio/PDF/unknown types even though `classifyFiles` groups by type. Use a stable sequence ID, not filename order or array index after regrouping.
- [ ] Remove a row while `detectFileKind` is still reading its header. When detection resolves, it must not forward the removed file into `useImageBatch` or `useAudioBatch` and recreate it.
- [ ] Reset or leave the workspace while classification is pending. Late promises must not repopulate the list or call state setters after unmount.
- [ ] Add another file after some rows are done. Keep prior rows, result links, errors, and each prior output selection unchanged.
- [ ] Add two different files with the same name, and add the same file again. Rows and React keys must remain distinct; each row must retain its own target and status.
- [ ] Remove the first, middle, and last row while other rows remain. Only that row's coordinator state and matching hook entry should be removed; focus should move to a surviving row or the picker.

## Capability readiness and file limits

- [ ] Do not call image/audio `addFiles` before the corresponding capability request is ready. Image `addFiles` closes over the current `limits` state; audio starts with `DEFAULT_AUDIO_LIMITS` and does not revalidate entries when capabilities later arrive. Otherwise a server limit smaller than the defaults can be bypassed at preflight.
- [ ] If image capability loading fails but audio is ready (or the reverse), keep the supported rows usable and mark only the affected type unavailable. Do not enable an output option whose capability state is still unknown.
- [ ] Offer only `support.encode[format] === true` image targets and only `limits.outputFormats` audio targets. If a capability response omits a tool or offers no outputs, show a row-level reason and never substitute a default format.
- [ ] Enforce one combined `jobs.maxBatchFiles` limit across image, audio, PDF, and visible unknown rows. The existing image and audio hooks each enforce their own per-hook count; adding files to both can otherwise exceed the server batch cap.
- [ ] Reserve combined capacity synchronously before awaiting classification or forwarding to hooks. Two rapid picker/drop events must not both use the same stale React count and over-accept files.
- [ ] Handle hook-level `AddFilesOutcome.rejected` explicitly. The coordinator must not show a rejected file as processable, silently lose its row, or leave a checking row forever.
- [ ] Decide whether unknown rows count toward the combined cap and apply that rule consistently; they remain visible but are not sent to a processor.
- [ ] Verify image bytes/dimensions, audio bytes and later server duration/channel limits, and PDF byte limits remain per-file checks. A large/invalid item must not suppress valid neighbors.
- [ ] Keep PDF's advertised `maxFileBytes` and the common `maxBatchFiles` in the new PDF path; current `PdfCompressor` is single-file and does not enforce a batch cap.

## Per-row targets and dispatch

- [ ] Capture a target-settings snapshot when “Konvertieren” starts. Either lock selectors during processing or ensure later UI changes cannot alter options for already queued jobs.
- [ ] With two audio rows set to different formats, verify the resolver's setting is used for each entry's `buildAudioOptions`, idempotency serialization, output extension/name, and result-format fallback. The current working-tree hook accepts a resolver, but every downstream value must use that same resolved setting.
- [ ] With two image rows set to different formats, verify each resolver result reaches the server options and matching output filename/result metadata. The image hook already resolves options per target entry.
- [ ] Use the `include` filter to dispatch only rows with a valid selection. The hooks' `counts.processable` includes every ready/done/error row, including rows that an `include` filter omits; coordinator button eligibility and counts must reflect selected processable rows instead.
- [ ] Never invoke a resolver with a missing/unsupported target and allow an undefined value to reach filename generation or `createJob`. A missing selection must disable or skip that row with a clear reason.
- [ ] Verify identical input/output format still gets the existing `-konvertiert` suffix, and changed formats get the expected destination extension. Keep duplicate-name disambiguation within each processor batch.
- [ ] PDF offers its existing compression action and three-level result behavior only. A PDF row must not receive an image/audio output-format selector or be sent through a conversion tool.
- [ ] Start a mixed batch containing valid image/audio rows, an invalid row, an unknown row, and a PDF. Each valid supported row must be attempted and each status/result must stay associated with its own stable row ID.

## Shared concurrency, repeated starts, and API scheduling

- [ ] Double-click “Konvertieren” before React rerenders. Use a synchronous coordinator lock/ref so the second event cannot dispatch a second cross-kind run; each individual hook's `processingRef` only protects that hook.
- [ ] Enforce a single active-job ceiling across image, audio, and PDF work. Image and audio independently set workers to `min(2, maxActivePerSession)`; starting both with `Promise.all` can double the advertised session concurrency. The current PDF component has no worker pool.
- [ ] If processing types sequentially, continue to the next type after an individual hook returns failures, and release the global lock in `finally` even if a dispatch unexpectedly throws.
- [ ] Exercise `createJob` responses for `rate-limited`, `session-job-limit`, and `server-busy`. It retries within a 15-minute scheduling deadline and calls `onWaiting`; preserve per-row waiting status and ensure removal/unmount aborts the retry delay.
- [ ] Re-run a failed row with unchanged options and with changed options. Keep/reuse an idempotency key only for the same serialized options; a changed destination must not replay a job created for the old destination.
- [ ] Start a new run after a previous result. Existing jobs are discarded before rerun; retain the hook behavior that clears stale result URLs and deletes superseded jobs.
- [ ] Aggregate progress from rows still in the current run. Hook summaries use the original target count, while hook `progress` excludes entries removed during processing; avoid reporting removed rows as still pending.

## Remove, reset, expiry, and unmount cleanup

- [ ] Remove an entry while it is queued before a worker takes it. The worker must skip it after the queue advances.
- [ ] Remove during `createJob`/upload, including after the server accepts the job but before the hook records its ID. Abort the controller; if a late accepted job arrives, immediately `deleteJob` it and do not publish it into the row.
- [ ] Remove while polling. Abort polling, request job deletion, and suppress any later status/result patch for that removed ID.
- [ ] Remove an already completed row. Revoke its coordinator association and issue the existing job deletion so its download URL is no longer presented as live.
- [ ] Reset during classification, preflight, `createJob`, waiting retry, and polling. Clear coordinator rows and selections and call every relevant hook's `reset` so pending work is aborted and known server jobs are deleted.
- [ ] Unmount the direct workspace with queued or active work. Preserve hooks' cleanup pattern (`releaseAll`, abort controllers, delete known jobs); after an accepted response races with unmount, ensure the accepted job is deleted rather than orphaned.
- [ ] Keep output selection changes and Add Files behavior consistent while one kind is processing. If additions remain enabled, they must not enter the current run snapshot or change its progress denominator.
- [ ] When download expiry fires, update only that row and clear only its expired link. Adding/removing other rows must not reset expiry timers or hide their results.

## API and privacy invariants

- [ ] Choosing, classifying, adding, removing, or changing output must not call `createJob`; the first file upload remains behind the explicit start action.
- [ ] Classification and format selection operate on in-memory `File` objects only. Keep the existing API's per-entry `createJob` / `pollJob` / `deleteJob` lifecycle and do not persist files or selections to browser storage.
- [ ] For every processing request, assert multipart `options` contains the row's selected target and the expected tool. For cancelled/removed rows, assert any job accepted during the race receives a delete request.
