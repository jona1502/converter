# Direct conversion test reconnaissance

Spec: `docs/superpowers/specs/2026-11-13-direkte-dateiauswahl-konvertierung.md`.

## Meaningful coverage

- **One persistent list:** choose and drop the same supported file and assert matching rows with name, size, detected input type, and per-file output control; the old “Was soll passieren?” step should never appear. Add a second file without losing the first row or its selected format; removing one row must leave the other intact, and removing the last returns to the dropzone.
- **Type-specific choices:** WAV has MP3/WAV/FLAC/OGG; a real output selection (WAV → MP3) is preserved at start and reaches processing as MP3. Image choices are limited to browser-available encoders. PDF offers compression only. Unknown/invalid/over-limit files retain a row-level reason and no invalid action, while valid neighbors remain usable.
- **Per-file options and results:** assign two different targets in a mixed list, start, and assert each processing request uses the target associated with its file. Include a failed item beside a successful one and assert statuses/downloads remain attached to the right rows. Image `processAll` already accepts a per-entry options resolver; audio currently takes one shared settings object, so direct audio conversion needs that path extended or equivalent per-entry dispatch.
- **Explicit start and access:** assert no jobs POST while choosing/adding/changing formats and exactly the expected processing request(s) after start; retain the existing storage/privacy audit. Cover keyboard selection, format choice, remove, start, and live announcements. Check 390 px and 1440 px in light and dark themes for no horizontal overflow and axe violations.

## Existing fixtures and helpers

- `e2e/quickstart.spec.ts`: reusable API doubles (`open`), `choose`, 1×1 PNG, WAV-header helper, minimal PDF, and unknown text. Its `open` already counts job POSTs and watches Web Storage/IndexedDB/Cache. The 1×1 quickstart PNG is mainly a sniffing fixture; for image preflight/processing use a valid canvas PNG as in `e2e/image-workspace.spec.ts` or `e2e/convert.spec.ts`.
- `e2e/audio-workspace.spec.ts`: good small valid PCM WAV generator, mocked API, and `optionsOf(request)` to assert serialized multipart options. Use this pattern for direct per-file destinations without requiring a backend.
- `e2e/audio-convert.spec.ts`: generated 1-second 44.1-kHz stereo WAV and actual WAV→MP3→WAV checks; this exercises the full stack. Committed audio samples are under `server/internal/jobs/testdata/audio/tone.{mp3,flac,ogg,wav}`. `converter/testdata/headers/*` are header/probe fixtures, not full processing inputs.
- Unit signature/classification coverage is in `tests/unit/quickstart.test.ts`; browser unit tests can use helpers under `tests/unit/helpers/`.

## Existing homepage assertions to update

- `e2e/quickstart.spec.ts` is the main old-flow suite. Replace the “Was soll passieren?” and choose-action expectations (including keyboard, history/reset, mixed-type grouping, and tool handoff) with persistent-row behavior. Keep/adapt its drag/drop, no-upload, privacy, unknown-type, and responsive/accessibility checks.
- `e2e/home.spec.ts` only checks the initial empty title/dropzone and reachable links; those assertions still fit the spec. `e2e/site.spec.ts`, `e2e/navigation.spec.ts`, and homepage checks in `e2e/accessibility.spec.ts` exercise route metadata or site navigation, not the removed action-selection step.

## Commands and setup

- Spec-requested baseline: `npm run check`, `npm test`, `npm run build`.
- Focused UI run: `npm run test:e2e -- e2e/direct-conversion.spec.ts --project=chromium` (or the adapted `e2e/quickstart.spec.ts`). Playwright serves the production preview on port 4329; UI tests with API doubles need no backend. `e2e/audio-convert.spec.ts` is a real-stack test and does require the audio service.
- `npm test` runs `tests/unit/**/*.test.ts` in headless Chromium, Firefox, and WebKit, with file-level parallelism disabled. Playwright’s full configured E2E matrix is Chromium, Firefox, WebKit, and Pixel 7 mobile.
