# Direct File Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Show selected files immediately with compatible output selectors, explicit processing and file-specific results on the homepage.

**Architecture:** Replace the homepage action-choice stage with a persistent file queue. Reuse existing batch hooks, signature checks, format catalogs and API lifecycle; retain existing secondary tools. Extend batch interfaces narrowly where per-entry settings or processing subsets are needed.

**Tech Stack:** Astro, React, TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-13-direkte-dateiauswahl-konvertierung.md`

## Global Constraints

- Preserve existing server-backed processing for both images and audio. The spec's local-image statement predates current implementation; do not switch processing engines.
- No upload before explicit processing start; files stay in memory, never browser storage.
- Use existing limits and advertised capabilities. Audio targets: MP3, WAV, FLAC, OGG, restricted by capabilities.
- Preserve comments, existing standalone tools and secondary image/PDF actions.
- User authorized implementation and new branch; use Luna max workers and Sol at most medium. No further approval gate.

## Review Focus

- Asynchronous detection after removal must never resurrect a file.
- Mixed files and invalid entries must not block valid conversions.
- Appending files must preserve selected formats and completed results.
- Per-entry outputs must reach actual job options and output filenames.
- Capability loading/failure and repeated processing must not allow invalid starts or duplicate jobs.

### Task 1: Persistent homepage conversion queue

**Files:** Modify `src/components/home/QuickStart.tsx`; create focused homepage helpers/components as needed; narrowly extend `src/components/tools/useAudioBatch.ts` and `useImageBatch.ts` if necessary. Add behavior tests in `e2e/quickstart.spec.ts` or a dedicated homepage spec and relevant unit tests.

**Interfaces:** Existing batch hooks expose entries, limits, support, addFiles, remove and processAll. Keep existing callers compatible. Image processAll already accepts an options resolver; audio may accept `AudioSettings | ((entry: AudioEntry) => AudioSettings)` while retaining the existing object call.

- [x] Write and run failing tests: selected image/audio exposes output without an action-choice page; two audio rows can choose different formats; append/remove preserves remaining selections; mixed unknown/PDF entries stay visible without uploads.
- [x] Implement stable queue identities, immediate checking rows, capability-based output choices, explicit processing, per-file status/results/downloads, and last-removal reset. Reuse actual existing validation and lifecycle paths. Keep accessible secondary image and PDF actions on the same page.
- [x] Verify actual job options/filenames for different audio/image outputs, removal during checking, duplicate names, no pre-start uploads, capability failure and per-file error isolation.
- [x] Run focused tests and `npm run check`. Record files changed and exact test evidence in `docs/superpowers/reviews/direct-conversion-implementation.md`.

### Task 2: Browser regression coverage and acceptance

**Files:** Update `e2e/quickstart.spec.ts` and homepage-dependent assertions in other e2e files only where behavior changed. No deletion of unrelated coverage.

**Interfaces:** Consume Task 1's labeled output selectors and stable `.file-row` containers. Use API doubles, real file signatures and real DOM interactions.

- [x] Adjust previous action-choice expectations to direct conversion; test picker and drag-and-drop, mixed types, append/remove, different outputs and explicit starts with request-body assertions.
- [x] Exercise keyboard controls and axe at 390/1440 px in light/dark themes; verify no horizontal overflow with long filenames.
- [x] Run `npm run check`, `npm test`, `npm run build` and relevant Playwright projects. Report infrastructure failures separately from product failures.
- [x] Independent review of spec compliance and code quality; fix confirmed issues, verify affected tests and record final evidence.
