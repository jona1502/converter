# Markdown zu PDF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add a complete Markdown upload to downloadable PDF workflow.

**Architecture:** Reuse the server job pipeline. Parse Markdown in the isolated Python codec process and render selectable text directly into PDF. Extend the canonical API and existing React workspace patterns.

**Tech Stack:** Astro/React/TypeScript, Go/PostgreSQL, Python, markdown-it-py, ReportLab.

**Spec:** `docs/superpowers/specs/2026-11-17-markdown-to-pdf-design.md` (approved in conversation).

## Global Constraints

- Werkzeug `markdown-pdf`, Eingabeformat `markdown`, ein Ergebnis `application/pdf`.
- Seite `/pdf/markdown`, Titel „Markdown zu PDF“, Startaktion „PDF erstellen“.
- Maximal 2.097.152 Bytes Eingabe, 20.971.520 Bytes Ausgabe, 300 Seiten und 120 Sekunden Prozesslaufzeit.
- UTF-8 mit optionalem BOM; keine leeren Dateien oder Binärdaten.
- A4-Hochformat, auswählbarer Text, eingebettete lizenzierte Schrift mit Umlauten.
- Überschriften, Absätze, Listen, Zitate, Links, Tabellen und Codeblöcke; lange Zeilen und Tabellenzellen umbrechen, Tabellenkopf wiederholen.
- Keine HTML-Ausführung oder Ressourcenauflösung; Bilder nur als Alternativtext. Aktive Links nur `https`, `http`, `mailto`.
- Bestehende Sandbox, Sitzungen, Downloads, Löschung und andere Werkzeuge beibehalten.
- Kein Push, Merge oder Deployment.

## Review Focus

1. Extremely long unbroken code and table cells must fit pages without content loss (Task 1).
2. UTF-8 BOM, invalid UTF-8, control characters and whitespace-only sources are handled deliberately (Tasks 1, 2).
3. Resource references and unsafe links must not disclose files or fetch URLs (Task 1).
4. Jobs survive queue processing and publish one correctly named, bounded PDF (Task 2).
5. Selection does not upload; errors, polling, removal and download work in the browser (Task 3).

### Task 1: Isolated Markdown renderer

**Files:** `converter/converter/options.py`, `limits.py`, `protocol.py`, `execute.py`, `probe.py`, new `processing/markdown/` module, `converter/tests/test_markdown_processing.py`, `converter/pyproject.toml`, `converter/uv.lock`, bundled font and license, Dockerfiles if needed.

**Interfaces:** Add `MarkdownOptions` accepting exactly `{"tool":"markdown-pdf"}`. Exactly one result target with null level. Pipeline `convert(source: Path, destination: Path, limits: Limits) -> dict[str, object]` produces details `{"pageCount": positive integer}`. Introduce `markdown_max_input_bytes`, `markdown_max_output_bytes`, `markdown_max_pages` defaults as specified and matching camelCase protocol names; new limit fields may be omitted by old callers and default safely. Existing required fields remain required. Use existing errors (`decode-failed`, `file-too-large`, `result-too-large`, `dimensions-too-large`, `encode-failed`) consistently. Add capability probe section `markdown: {available: boolean}` based on an actual rendering check.

- [ ] Write failing tests covering syntax, selectable text/Umlauts, multipage output, long code/table wrapping, repeated table headers, UTF-8/BOM, binary/empty rejection, size/page/output boundaries, unsafe links and image/HTML resource references.
- [ ] Run focused tests and record expected failure before implementation.
- [ ] Implement renderer and process integration, pinned reproducible dependencies and bundled licensed font; no generic HTML/image resource resolver.
- [ ] Run the converter pytest suite, Ruff and mypy. Generate a sample for visual QA and report its absolute path. Record unavailable environment checks explicitly.
- [ ] Commit only task files; write report with commands, results, public interfaces and concerns.

### Task 2: Go/API/job integration

**Files:** `api/openapi.json`, generated `src/lib/api/generated.ts`, Go `internal/apitypes`, `httpapi/endpoints`, `jobs`, `converter`, `config`, new `server/migrations/0005_markdown.sql`, associated tests and fixtures.

**Interfaces:** Consume Task 1 options, limit names, capability and pageCount details exactly. Expose `markdown-pdf` through existing POST jobs. Keep canonical options `{"tool":"markdown-pdf"}`. Public capabilities include Markdown availability and input/output/page limits using existing API conventions. Full streamed input must be checked for UTF-8/control characters and non-whitespace, not just a signature prefix; accept `.md`/`.markdown` file names and optional UTF-8 BOM. Result is `<sanitized-stem>.pdf`, MIME `application/pdf`, one result, 120 second timeout and 20.971.520 byte output reservation. Extend migration constraints additively, preserving existing formats and tools.

- [ ] Write and run failing tests for options union, validation boundaries including invalid bytes beyond sniff window, naming, capability gating, worker request and result details.
- [ ] Extend API schema/types, job creation/processing, storage accounting and converter protocol handling. Regenerate browser API types.
- [ ] Run `go test ./...` and `go vet ./...` where available, type generation check, migration/integration tests against isolated test DB if available. Report unavailable Linux/database checks.
- [ ] Commit task files and report exact capability shape, errors, tests and limits for frontend consumption.

### Task 3: Frontend, end-to-end behavior and documentation

**Files:** new `src/pages/pdf/markdown.astro`, `src/components/tools/MarkdownConverter.tsx` and focused hook/helpers as needed, `src/data/tools.ts`, `src/lib/quickstart.ts`, `src/components/home/QuickStart.tsx`, tests, `e2e/markdown.spec.ts`, `README.md`.

**Interfaces:** Consume actual generated API and Task 2 capabilities. Reuse ToolWorkspace, DropZone, ActionBar, existing server client and session/download/removal behavior. Keep exactly the page, labels, supported input and explicit upload behavior in Global Constraints. Single input at a time is sufficient.

- [ ] Add failing tests for registration, file classification, explicit start (no upload on select), limits and error presentation.
- [ ] Implement accessible file selection, availability check, server submission/polling, downloadable result, cancellation/removal and reset using existing patterns. Describe supported syntax, image handling and font coverage honestly.
- [ ] Add E2E test against real stack: select Markdown, start, wait, download and assert PDF header; errors and removal. Update README with support/limits.
- [ ] Run `npm run check`, `npm test`, `npm run build`, API generation check and focused E2E if stack available. Report missing services rather than fabricate success.
- [ ] Commit and report verification. Independent review follows each task; final review covers whole branch and visual PDF QA.
