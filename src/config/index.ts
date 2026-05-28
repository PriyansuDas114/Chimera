import * as path from "path";
import * as os from "os";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

/**
 * Central configuration for CHIMERA.
 * Loads from environment variables with sensible local-first defaults.
 *
 * Provider Selection:
 *   Set CHIMERA_PROVIDER=openrouter to use OpenRouter (200+ cloud models).
 *   Set CHIMERA_PROVIDER=ollama (default) to use local Ollama models.
 */
export const CONFIG = {

  // ── Active Provider ──────────────────────────────────────────────────────────
  // Which LLM backend to use. Options: "ollama" | "openrouter"
  ACTIVE_PROVIDER: (process.env["CHIMERA_PROVIDER"] ?? "ollama") as "ollama" | "openrouter",

  // ── Ollama Settings ──────────────────────────────────────────────────────────
  OLLAMA: {
    BASE_URL: process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434",
    MODELS: {
      SUPERVISOR: process.env["OLLAMA_SUPERVISOR_MODEL"] ?? "llama3.1",
      CODER:      process.env["OLLAMA_CODER_MODEL"]      ?? "qwen2.5-coder:7b",
      AUDITOR:    process.env["OLLAMA_AUDITOR_MODEL"]    ?? "llama3.1",
      RESEARCHER: process.env["OLLAMA_RESEARCHER_MODEL"] ?? "llama3.1",
      QA:         process.env["OLLAMA_QA_MODEL"]         ?? "llama3.1",
    },
    DEFAULT_TEMPERATURE: parseFloat(process.env["OLLAMA_TEMPERATURE"] ?? "0.15"),
    DEFAULT_NUM_CTX:     parseInt(process.env["OLLAMA_NUM_CTX"] ?? "32768", 10),
    DEFAULT_NUM_PREDICT: parseInt(process.env["OLLAMA_NUM_PREDICT"] ?? "4096", 10),
    KEEP_ALIVE:          process.env["OLLAMA_KEEP_ALIVE"] ?? "60m",
  },

  // ── OpenRouter Settings ──────────────────────────────────────────────────────
  // Get a free API key at: https://openrouter.ai/keys
  // Model format: "provider/model-name", e.g. "openai/gpt-4o", "anthropic/claude-3-5-sonnet"
  OPENROUTER: {
    BASE_URL: "https://openrouter.ai/api/v1",
    API_KEY:  process.env["OPENROUTER_API_KEY"] ?? "",
    MODELS: {
      // High-capability default models for each role.
      // Change these in .env to use different models.
      SUPERVISOR: process.env["OR_SUPERVISOR_MODEL"]  ?? "google/gemini-2.0-flash-001",
      CODER:      process.env["OR_CODER_MODEL"]       ?? "anthropic/claude-sonnet-4-5",
      AUDITOR:    process.env["OR_AUDITOR_MODEL"]     ?? "anthropic/claude-sonnet-4-5",
      RESEARCHER: process.env["OR_RESEARCHER_MODEL"]  ?? "google/gemini-2.0-flash-001",
      QA:         process.env["OR_QA_MODEL"]          ?? "google/gemini-2.0-flash-001",
    },
  },

  // ── Storage Paths ────────────────────────────────────────────────────────────
  PATHS: {
    DATA_DIR:    process.env["CHIMERA_DATA_DIR"] ?? process.env["MAE_DATA_DIR"] ?? "./data",
    get SESSIONS_DIR() { return path.join(this.DATA_DIR, "sessions"); },
    get VECTOR_DIR()   { return path.join(this.DATA_DIR, "vectors"); },
  },

  // ── Execution Limits ─────────────────────────────────────────────────────────
  LIMITS: {
    MAX_GRAPH_STEPS:         parseInt(process.env["MAX_GRAPH_STEPS"] ?? "50", 10),
    MAX_TOOL_CALLS_PER_TURN: parseInt(process.env["MAX_TOOL_CALLS_PER_TURN"] ?? "5", 10),
    RECURSION_LIMIT:         parseInt(process.env["RECURSION_LIMIT"] ?? "100", 10),
    SHELL_TIMEOUT_MS:        parseInt(process.env["SHELL_TIMEOUT_MS"] ?? "30000", 10),
    MAX_FILE_READ_CHARS:     parseInt(process.env["MAX_FILE_READ_CHARS"] ?? "32000", 10),
  },

  // ── Security ─────────────────────────────────────────────────────────────────
  SECURITY: {
    DEFAULT_SAFETY_MODE: "STRICT" as "STRICT" | "COMMAND_ONLY" | "AUTO_APPROVE" | "READ_ONLY",
    BLOCKED_COMMANDS: [
      /rm\s+-rf\s+\/(?:\s|$)/,
      /mkfs/,
      /dd\s+if=.*of=\/dev\//,
      /:\(\)\{.*\}/,
      /chmod\s+-R\s+777\s+\//,
      />\s*\/dev\/sd[a-z]/,
    ],
    SAFE_COMMANDS: [
      /^git\s+(?:status|diff|log|show|branch)/,
      /^npm\s+run\s+(?:typecheck|lint)/,
      /^npm\s+test(?:\s|$)/,
      /^node\s+(?:-v|--version)(?:\s|$)/,
    ],
  },
} as const;

// ─── Derived Helpers ──────────────────────────────────────────────────────────

/**
 * Returns the model names for the active provider.
 * Use this instead of accessing OLLAMA.MODELS or OPENROUTER.MODELS directly.
 */
export function getActiveModels() {
  return CONFIG.ACTIVE_PROVIDER === "openrouter"
    ? CONFIG.OPENROUTER.MODELS
    : CONFIG.OLLAMA.MODELS;
}

