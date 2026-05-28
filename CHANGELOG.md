# Multi-Agent Engine (MAE) — Changelog

All notable changes to this project will be documented in this file.

## [2026-05-18] — Orchestration Reliability & Premium UX
### Added
- **Proactive Lazy Loop Detection**: Implemented `LazyLoopDetector` (`src/graph/loop_detector.ts`) to intercept infinite execution loops in the multi-agent graph. The detector uses multiple advanced heuristics:
  - *Identical Tool Calls*: Intercepts identical tool invocations (same name and arguments) made 3 times consecutively without state mutations (like file writes).
  - *Worker Node Chat Ping-Pong*: Halts conversational loops where specialized workers repeatedly output similar text without executing productive tools.
  - *Periodic Sequence Traversal*: Detects repeating execution patterns of length 2, 3, or 4 (e.g., Coder -> QA -> Supervisor sequence).
- **Unit Test Suite for Loop Detection**: Created a complete set of automated tests in `tests/loop_detector.test.ts` to verify loop interception heuristics.
- **Premium Live Markdown Stream Highlighter**: Added `LiveMarkdownStream` (`src/cli/renderer.ts`) to enable real-time, line-buffered syntax highlighting and markdown parsing during streaming.
  - *Language-specific Syntax Highlighting*: Built advanced lexers for JavaScript, TypeScript, Bash, JSON, and common CLI tools.
  - *Sleek Terminal Frames*: Code blocks are rendered inside beautiful, dark side-bordered cards with a customized language badge.
  - *Advanced Elements*: Added full terminal support for blockquotes (with vertical indent bars), bolding, italics, bullets, numbered lists, and shaded inline code blocks.
- **Unit Test Suite for Renderer**: Added `tests/renderer.test.ts` to verify bulleting, list parsing, inline code formatting, blockquotes, and code block tokenization.
- **Single-Line Live Tool Monitor**: Replaced multiple, sparse terminal log lines generated per tool call with a single-line animated spinner (`⠋ Running: read_file...`). This dramatically reduces visual clutter in the terminal.
- **Collapsible Tool Summary**: Once the AI begins generating its conversational response, the live tool monitor automatically collapses the list of executed tools into a beautiful, single-line summary (e.g., `✔ Called 5 tools [read_file, list_dir, read_file]`), matching the premium drop-down feel of Claude Code.
- **Interactive Startup Session Picker**: Scans the session database directory at launch and prompts the developer to either resume an active recent session or start a new one directly using a polished Clack choice select menu.
- **Conversational History Visualizer**: Restores conversation history of resumed sessions directly from SQLite checkpoints using `agent.getState()`, outputting the last 6 dialogue turns in a beautifully indented, syntax-highlighted visual layout.
- **Interactive Dashboard CLI Manager (`mae sessions`)**: Triggers an interactive sessions hub if run without arguments. Developers can view, inspect full metadata (created/updated/steps/cwd), delete specific sessions with safety confirmations, delete all sessions, or resume a chosen session directly into the REPL.
- **Unit Test Suite for SessionStore**: Created `tests/session.test.ts` to test session CRUD lifecycle operations, state updates, list sorting, and cascading deletions.

### Changed
- **Unified RunOptions Configuration**: Upgraded `RunOptions` in `runner.ts` and `execute_task` tool in `primary.ts` to explicitly allow optional parameters (`maxSteps`, `temperature`, `model`) with strict TypeScript compliance.
- **Incremental Conversational Output**: Wired `LiveMarkdownStream` into the Primary Agent conversational REPL in `src/cli/index.ts` to stream gorgeously formatted text token-by-token.
- **Goal-Aware Static List Table**: Upgraded the static `mae sessions list` table format to use short Git-style IDs, and dynamically print a wide `GOAL / TOPIC` column for maximum diagnostic visibility.

### Fixed
- **TypeScript Exact Optional Types**: Resolved index signature access issues (bracket notation on `configurable`) and duplicate path imports inside CLI entry points.
- **Hanging Terminal Intervals**: Implemented safe resource management using nested `try-finally` blocks around the event streams to guarantee all live CLI spinners are cleanly terminated upon turn completion or exit.

---

## [2026-05-14] — Unified Conversational Interface
### Added
- **Unified CLI REPL**: Merged `run` and `chat` modes into a single interactive environment modeled after Claude Code.
- **Primary Agent**: Created a high-level conversational agent (`src/cli/primary.ts`) to manage chat history and codebase queries.
- **Delegation Bridge**: Implemented the `execute_task` tool, allowing the Primary Agent to delegate complex coding tasks to the multi-agent Orchestrator graph.
- **Windows Convenience Shim**: Added `mae.cmd` to the project root to bypass PowerShell execution policy restrictions.

### Changed
- **Persistent Chat History**: Integrated the `SqliteCheckpointer` into the Primary Agent to maintain conversation state across restarts via the `--session` flag.
- **Optimized Initialization**: Refactored the startup flow to only require the working directory, removing redundant goal prompts.
- **Live Configuration UI**: Updated the CLI banner to display the active supervisor model and connection status in real-time.

### Fixed
- **Strict TypeScript Compliance**: Resolved all `exactOptionalPropertyTypes` and `never` type errors in the checkpointer, vector store, and LLM factory.
- **Environment Loading Race Condition**: Moved `dotenv` initialization to the top of the configuration module to ensure ESM imports correctly resolve environment variables.
- **Missing Internal Imports**: Fixed several missing imports (e.g., `CONFIG` in `renderer.ts` and `search.ts`).

---

## [2026-05-14] — Architectural Hardening & Security
### Added
- **Centralized Configuration**: Created `src/config/index.ts` to manage environment variables, model defaults, and execution limits.
- **Centralized Types**: Created `src/types/index.ts` to unify core interfaces across the CLI, graph, and agents.
- **Native Test Suite**: Implemented automated testing using `node:test` and `tsx`. (Tests added for Config, Tools, and Runner).
- **Graceful Search Fallback**: Added `git grep` support to the search tool for environments without a vector index.

### Changed
- **Per-Worker Tool Scoping (Security)**: Restricted tool access for specialized agents. Auditor and Researcher are now read-only (no shell or write access).
- **Config Migration**: Refactored `llm.ts`, `shell.ts`, `runner.ts`, `cli/index.ts`, and `embedder.ts` to use the new centralized config.

### Fixed
- **Broken Imports**: Resolved all circular and missing imports following the configuration refactor.
- **PowerShell Security Errors**: Updated test execution instructions to bypass execution policy restrictions on Windows.

---

## [2026-05-13] — Persistence & Reliability
### Added
- **Persistent REPL Loop**: Implemented a `while(true)` loop in the CLI to support multi-turn pairing sessions within a single thread.
- **Session Persistence**: Fully wired LangGraph's `SqliteCheckpointer` into the runner.

### Changed
- **Max Output Tokens**: Increased `numPredict` to 2048 to prevent Supervisor JSON truncation.
- **Context Window**: Increased `numCtx` to 32k for handling long session histories.
- **Researcher Strategy**: Updated the Researcher's persona to proactively read files instead of looping on directory listings.

### Fixed
- **Database Race Condition**: Refactored `SessionStore` lifecycle to prevent "The database connection is not open" errors during background writes.
- **Supervisor JSON Parse Failures**: Added heuristic JSON repair to handle unquoted fields from the LLM.
- **Tool Schema Compliance**: Made `cwd` optional in all filesystem tools to prevent infinite validation loops.

---

## [2026-05-12] — Project Inception (v0.1.0)
### Added
- **Core Orchestrator**: LangGraph-based engine with Supervisor routing.
- **Agent Team**: Coder, Auditor, Researcher, and QA Engineer nodes.
- **Initial Toolset**: Filesystem, Shell (with HITL gateway), and Vector Search.
- **CLI Interface**: Interactive and non-interactive task execution modes.
- **Session Store**: SQLite-based history management.
