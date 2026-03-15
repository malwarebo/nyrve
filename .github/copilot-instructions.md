# Forge IDE — AI-Native Code Editor

## What Is This Project

Forge is a VS Code fork with Claude's agentic coding capabilities deeply integrated into every layer of the editor. Unlike Cursor (interactive AI editing) or Copilot (AI bolted onto an existing editor), Forge treats the AI agent as a first-class citizen — capable of autonomous multi-file edits, background monitoring, GitHub workflow automation, and persistent project memory.

**Full product specification:** `.claude/forge-spec.md`
Always reference this spec when implementing features. Follow the architecture, interfaces, file structure, and naming conventions defined there.

## Project Architecture

Forge inherits VS Code's layered architecture and adds a `src/forge/` directory for all Forge-specific code. Never modify VS Code core files directly unless absolutely necessary — prefer extending via contribution points and service injection.

### Forge-Specific Code (`src/forge/`)

All new Forge code lives here. This is the code YOU are building:

```
src/forge/
├── agent/           # Core agent engine, orchestration, action execution (Claude models only — Opus, Sonnet, Haiku)
├── context/         # @-mention system, context builder, editor bridge
├── indexer/         # Codebase indexer (Rust native addon in indexer/native/)
├── memory/          # Session memory, auto-extraction, decay
├── github/          # GitHub API integration, PR/issue management, CI monitoring
├── ui/              # All Forge UI panels (agent chat, diff review, task queue, etc.)
├── api/             # Public extension API for third-party integrations
└── core/            # Config, storage, encryption, updater
```

### VS Code Base Architecture (read-only reference)

You need to understand these but should rarely modify them:

- `src/vs/base/` — Foundation utilities and cross-platform abstractions
- `src/vs/platform/` — Platform services and dependency injection infrastructure
- `src/vs/editor/` — Text editor (Monaco) implementation
- `src/vs/workbench/` — Main application workbench
  - `workbench/browser/` — Core workbench UI components (parts, layout, actions)
  - `workbench/services/` — Service implementations
  - `workbench/contrib/` — Feature contributions (git, debug, search, terminal, etc.)
  - `workbench/api/` — Extension host and VS Code API implementation
- `src/vs/code/` — Electron main process
- `src/vs/server/` — Server implementation

### Root Folders
- `src/` — Main TypeScript source with unit tests in `src/vs/*/test/` and `src/forge/*/test/`
- `build/` — Build scripts and CI/CD tools
- `extensions/` — Built-in extensions that ship with VS Code
- `test/` — Integration tests and test infrastructure
- `.forge/` — Per-project Forge runtime data (index.db, memory.db, tasks.db, config.json)
- `.claude/` — Claude Code config and project specs

### Core Principles
- **Layered architecture** — from `base` → `platform` → `editor` → `workbench` → `forge`
- **Dependency injection** — Services injected via constructor (non-service params come after service params)
- **Contribution model** — Features contribute to registries and extension points
- **Forge isolation** — All Forge code in `src/forge/`, never pollute VS Code core unless required for deep integration
- **Cross-platform** — Must work on macOS, Windows, and Linux

## Implementation Priorities

### Current Phase: Phase 1 — Foundation
Reference: `.claude/forge-spec.md` Section 9, Phase 1

1. ~~Fork VS Code and set up build pipeline with custom branding~~ (DONE if you're reading this)
2. Build `ForgeEditorBridge` — real-time editor state API (spec: FR-4.1.3)
3. Build Agent Panel UI — webview sidebar with chat interface and streaming (spec: FR-4.1.2)
4. Implement basic agent engine — send message → Claude API → stream response (spec: FR-4.1.1)
5. Implement file read/write actions with confirmation flow (spec: FR-4.1.4)
6. Implement terminal command execution (spec: FR-4.1.5)

### Critical: Remove Native VS Code AI Features
Before building Forge features, disable/remove VS Code's built-in AI chat and Copilot integration so only the Forge Agent Panel is visible. Reference: spec Section 6.

- Remove or disable `src/vs/workbench/contrib/chat/` (native chat sidebar)
- Remove the chat icon from the Activity Bar
- Remove all `chat.*` and `copilot.*` commands from the command palette
- Remove Copilot extension auto-install prompts and Welcome page references
- Remove "Ask Copilot" from right-click context menus
- Remove inline chat ghost text decorations
- Preferred approach: create `src/forge/core/forge-disable-native-ai.ts` that deregisters all chat/copilot contribution points at startup (cleaner than deleting source files for upstream sync)

### Up Next: Phase 2 — Tier 1 Features
- Forge Settings Page — full graphical settings UI (spec: Section 7.1)
- Rust-based codebase indexer (spec: Section 4.2)
- @-mention context system (spec: Section 4.4)
- Inline diff review flow (spec: Section 4.3)

### Later: Phase 3 — Tier 2 Features
- Background agent mode (spec: Section 5.1)
- GitHub-native workflows (spec: Section 5.2)
- Session memory engine (spec: Section 5.3)
- Task queue and orchestration panel (spec: Section 5.4)

## Key Interfaces to Know

When implementing v3 features, these are the critical interfaces. Always match the spec exactly.

### Inline Completions (spec v3: Section 2)
- `ICompletionEngine` — Section 2.3 — core completion logic
- `CompletionRequest` / `CompletionResult` — Section 2.3 — request/response types
- `ICompletionTrigger` — Section 2.4 — trigger rules and debounce
- `ICompletionPostProcessor` — Section 2.7 — trim, type check, format
- `IGhostTextRenderer` — Section 2.8 — Monaco inline decoration display

### Plan Mode (spec v3: Section 3)
- `Plan` / `PlanStep` / `PlanStatus` — Section 3.3 — plan data structures
- `IPlanGenerator` — Section 3.4 — generate and revise plans
- `IPlanExecutor` — Section 3.5 — execute steps with verification
- `PlanExecutionResult` / `StepExecutionResult` — Section 3.5 — execution results

### Vision (spec v3: Section 4)
- `IImageInput` / `ImageAttachment` — Section 4.3 — image input handling
- `IImageProcessor` — Section 4.4 — resize, compress, EXIF strip
- `VisionMessage` / `ImageBlock` — Section 4.5 — API content blocks

### Verification (spec v2: Section 2) — still in use
- `IVerificationEngine` / `VerificationReport` — orchestration and output
- `ISelfHealer` — retry loop

### Deep Memory (spec v2: Section 3) — still in use
- `ProjectDNA` — auto-built project understanding
- `DecisionEntry` — captured architectural decisions
- `IMemoryRetriever` / `MemoryContext` — query all layers

### Existing v1 Interfaces — still in use
- `EditorState` — real-time editor state snapshot
- `ContextBlock` — resolved @-mention context
- `Task` — task queue item

## Anthropic API Integration

Forge is a Claude-exclusive IDE. All AI features are powered by Claude via the Anthropic API. No third-party AI providers (OpenAI, Google, etc.) are supported or planned.

- **Authentication:** Bring-your-own-key model. Users paste their Anthropic API key into Forge. All API calls go directly from the user's machine to api.anthropic.com. There is no Forge backend or proxy. Reference: spec Section 6.
- **Key storage:** API key stored exclusively in the OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret) via VS Code's SecretStorage API. NEVER write the key to any file on disk, logs, settings, or environment variables.
- **Key validation:** On first setup, validate with a lightweight Haiku call (max_tokens=1). Handle 401 (invalid), 403 (no permission), 429 (rate limited) gracefully.
- **Model discovery:** After key validation, fetch available models from the Anthropic API and populate settings dropdowns with only models the user has access to.
- **Claude model family only:** Forge supports switching between all available Claude models (Opus, Sonnet, Haiku) — but never non-Claude models
- **Model switcher:** Users can select their preferred Claude model from a dropdown in the Agent Panel and in settings. The switcher should reflect all currently available Claude models from the Anthropic API.
- **Smart defaults:** Opus for complex agentic tasks (multi-file edits, planning, refactors), Sonnet for general chat and interactive use, Haiku for fast/lightweight tasks (background agent suggestions, quick completions)
- **Per-feature model override:** Users can configure which Claude model is used for each feature independently (e.g., Haiku for background agent, Opus for task queue execution)
- **Streaming:** Always use streaming responses. First token must appear within 2 seconds.
- **Token tracking:** Every API call must be tracked via `token-tracker.ts` for budget management, with cost displayed per-model since pricing differs
- **Error handling:** Agent crash must never crash the editor. Isolate with try/catch and auto-restart. Handle 401/403/429/500/529 per spec Section 6.4.2.
- **No-key mode:** Without an API key, Forge works as a normal code editor. All AI features are inactive but the editor functions normally.

## Validating Changes

MANDATORY: Always check for compilation errors before running tests or declaring work complete.

### TypeScript Compilation
- If `#runTasks/getTaskOutput` is available, check the `VS Code - Build` watch task output
- If not available and you changed code under `src/`, run `npm run compile-check-ts-native`
- If you changed built-in extensions under `extensions/`, run `npm run gulp compile-extensions`
- For changes in `build/` folder, run `npm run typecheck` in that folder
- NEVER use `npm run compile` to compile TypeScript files
- NEVER run tests if there are compilation errors

### Running Tests
- Unit tests: `scripts/test.sh` (or `scripts\test.bat` on Windows), use `--grep <pattern>` to filter
- Integration tests: `scripts/test-integration.sh` (or `scripts\test-integration.bat`)
- Forge-specific tests: `scripts/test.sh --grep "Forge"` (all Forge tests should be prefixed with "Forge:")
- Layering validation: `npm run valid-layers-check`

### Forge-Specific Validation
- After verification engine changes: test full loop (agent writes code → verification runs → self-heals → report shown with diffs)
- After test runner changes: test auto-detection on Jest, Vitest, pytest, Go test, Cargo test projects
- After self-healer changes: intentionally introduce a type error or test failure and verify the agent fixes it within 3 attempts
- After Project DNA changes: test initial scan on a real project with 1000+ files, verify scan < 2 minutes
- After decision journal changes: have a conversation about an architectural choice, verify the decision is auto-extracted
- After team knowledge changes: verify suggestion flow (agent suggests → user approves → appended to .forge/team-knowledge.md)
- After memory retriever changes: verify all 3 layers appear in agent context with correct priority ordering
- After any agent engine changes: test a full loop (user message → agent response → file edit → verification → confirmation)
- After indexer changes: test on a real project with 1000+ files, verify index build < 60s
- After diff review changes: test accept/reject/edit per-hunk and verify undo integration
- After @-mention changes: test autocomplete dropdown, resolution, and token budget trimming
- After memory browser changes: verify all 4 tabs render correctly with real data

## Coding Guidelines

### General Rules
- Use tabs, not spaces
- PascalCase for types and enum values
- camelCase for functions, methods, properties, local variables
- Use whole words in names when possible
- Arrow functions over anonymous function expressions
- Always surround loop/conditional bodies with curly braces
- Prefer `async`/`await` over `Promise.then()`
- All user-facing strings must be localized using `vs/nls`
- Microsoft copyright header on all files
- No `any` or `unknown` types unless absolutely necessary
- Do not duplicate code — look for existing utilities first
- Register disposables immediately after creation using `DisposableStore`, `MutableDisposable`, or `DisposableMap`
- Prefer `IEditorService` for opening editors
- Avoid `bind()`, `call()`, `apply()` — use arrow functions for context

### Forge-Specific Conventions
- All Forge services must be registered in the DI container following VS Code's pattern
- Forge UI panels use VS Code's webview API — they render inside the editor, not in a browser
- All Forge database operations (SQLite for index, memory, tasks) must be async and non-blocking
- Agent API calls must always use streaming and include abort controller support
- Background agent operations must respect the token budget in settings
- File writes from the agent must always go through the shadow buffer → diff review flow (never write directly unless user has `autonomous` confirmation level)
- All Forge settings must be namespaced under `forge.*` in the settings schema
- Forge config files live in `.forge/` at the project root
- Rust native addon code (indexer) lives in `src/forge/indexer/native/` with its own Cargo.toml

### Strings and UI Labels
- "double quotes" for user-facing localized strings
- 'single quotes' for everything else
- Use `{0}` placeholders, never string concatenation for localized strings
- Title-style capitalization for commands, buttons, menu items
- Don't capitalize prepositions of four or fewer letters (unless first/last word)

### Comments
- JSDoc style for functions, interfaces, enums, classes
- Inline comments for complex Forge-specific logic (agent orchestration, context building, etc.)

### Tests
- All Forge tests go in `src/forge/*/test/` alongside the source
- Test names prefixed with `Forge:` for easy filtering
- Prefer one `assert.deepStrictEqual` snapshot over many small assertions
- Don't add tests to wrong suites or create unnecessary test infrastructure

## Finding Code

1. **Forge code first:** If implementing a Forge feature, start in `src/forge/`
2. **Check the spec:** Reference `.claude/forge-spec.md` for interfaces, requirements, and architecture
3. **Semantic search** for general concepts in VS Code base
4. **Grep exact strings** for error messages or function names
5. **Follow imports** to understand module relationships
6. **Check test files** for usage patterns and expected behavior

## Upstream Sync

Forge tracks VS Code upstream releases. When syncing:
- All Forge code is in `src/forge/` — this should never conflict with upstream
- If upstream changes break Forge integration points, fix in `src/forge/` not in VS Code core
- Test full build and all Forge features after any upstream merge
- Branding overrides live in `product.json` — check these after upstream sync

## Quick Reference — Keyboard Shortcuts (Target)

These are the shortcuts we're implementing (from the spec):
- `Cmd+Shift+A` / `Ctrl+Shift+A` — Toggle Agent Panel
- `Cmd+I` — Quick inline agent input (Spotlight-style)
- `Cmd+Shift+I` — Send selection to agent
- `Cmd+Shift+Y` — Accept current diff hunk
- `Cmd+Shift+N` — Reject current diff hunk
- `Cmd+Shift+]` / `[` — Next/previous diff hunk
- `Cmd+Shift+Enter` — Accept all changes
- `Cmd+Shift+B` — Toggle background agent
- `Cmd+Shift+M` — Open memory browser
- `Cmd+Shift+T` — Toggle task queue panel
