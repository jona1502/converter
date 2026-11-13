# Direct conversion homepage regression adaptation

Date: 2026-11-13. Branch: `feature/direct-file-conversion`. No commits.

## Scope and preserved coverage

Restored `e2e/quickstart.spec.ts` from `HEAD` after an interrupted worker had removed it, then adapted all 13 named regressions and all four generated axe/theme/width variants to the direct homepage queue. The original signature fixtures, capability/session doubles, storage/IndexedDB/Cache instrumentation, CSP audit and its narrowly scoped WebKit exception remain. All existing comments remain, with a new clarification for the changed direct flow.

The suite now verifies direct image/audio output selectors and actual job bodies/download names; image compression and resizing with preserved queue results; PDF's existing compression tool with the selected file; signature-over-extension detection; visible unknown files and valid neighbors; mixed rows with PDF secondary return; append/remove and last-row focus; secondary-tool browser back/forward; drag-and-drop equivalence; keyboard file picker, native output selection, start and removal; and privacy/CSP checks through explicit conversion and lazy secondary loading.

The four dark/light × 390/1440 cases each scan empty, populated and completed queue states with axe. Mixed rows and long filenames exercise wrapping and no horizontal overflow. The job double returns deterministic completed jobs while recording real multipart request bodies. Product files were not edited for this task.

## Verification

- Command: `$env:E2E_BASE_URL='http://localhost:4333'; npx playwright test e2e/quickstart.spec.ts --output=.superpowers/sdd/direct-file-conversion/quickstart-results` against the parent's existing production preview.
- Initial run identified one incorrect test expectation: the homepage format catalog labels ICO as `ICO`, whereas the new assertion initially expected `ICO (Symbol)`. Corrected the expectation to the actual existing catalog label. No product workaround.
- Initial all-project result: **64 passed / 4 failed** (1.2m), with all four failures caused solely by the same ICO label assertion, corrected as described above.
- Corrected all-project result: **67 passed / 1 infrastructure failure** (1.0m). The sole failure was Chromium privacy `page.goto` reporting `net::ERR_CONNECTION_REFUSED` at `http://localhost:4333/` before the UI or assertions ran. The same preview accepted the surrounding tests; no product failure was observed. All 16 axe runs passed (four theme/viewport variants across four projects).
- Focused verification of the affected privacy test and strengthened keyboard assertion: `$env:E2E_BASE_URL='http://localhost:4333'; npx playwright test e2e/quickstart.spec.ts --grep 'Tastatur|Datenschutz' --output=.superpowers/sdd/direct-file-conversion/quickstart-targeted-results`: **8 passed** across Chromium, Firefox, WebKit and mobile (11.6s). The keyboard case now explicitly proves Home/ArrowDown selects PNG before Tab, start and removal. The previously interrupted Chromium privacy case passed on this rerun.
- All 68 project/test combinations have passing evidence after correcting the test fixture. The full corrected run remains recorded honestly as 67 passes plus one transient preview connection failure, rather than being described as a single clean 68-test run.
- `git diff --check -- e2e/quickstart.spec.ts`: exit 0, no whitespace errors. Git emits the repository's usual CRLF→LF normalization notice.

The parent owns final product checks, unit/build evidence, real-server smoke coverage and independent review. API doubles test the actual frontend job contract rather than backend transcoding quality.
