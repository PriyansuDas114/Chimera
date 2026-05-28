import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { CONFIG, getActiveModels } from "../config/index.js";
import { createLLM as registryCreateLLM } from "../providers/registry.js";

// ─── LLM Factory Options ──────────────────────────────────────────────────────

export interface LLMFactoryOptions {
  /** Model identifier. For Ollama: "llama3.1". For OpenRouter: "openai/gpt-4o". */
  model: string;
  /** Enable JSON-mode output formatting. */
  jsonMode?: boolean;
  /** Tools to bind to this LLM instance. */
  tools?: StructuredToolInterface[];
  /** Sampling temperature. */
  temperature?: number;
  /** Maximum tokens to generate (maps to numPredict for Ollama, maxTokens for OpenRouter). */
  maxTokens?: number;
  /** Override which provider to use (defaults to CHIMERA_PROVIDER env). */
  providerOverride?: string;
}

// ─── Main Factory ──────────────────────────────────────────────────────────────

/**
 * Creates a configured LLM instance using the active provider.
 * Routes to Ollama, OpenRouter, or any registered provider based on
 * the CHIMERA_PROVIDER environment variable (or providerOverride).
 */
export function createLLM(options: LLMFactoryOptions): BaseChatModel {
  return registryCreateLLM(
    {
      model: options.model,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens   !== undefined ? { maxTokens:   options.maxTokens   } : {}),
      ...(options.jsonMode    !== undefined ? { jsonMode:    options.jsonMode    } : {}),
      ...(options.tools       !== undefined ? { tools:       options.tools       } : {}),
    },
    options.providerOverride,
  );
}

// ─── Pre-built Supervisor Instance ───────────────────────────────────────────

/**
 * Creates the Supervisor LLM configured for JSON-mode routing decisions.
 * Uses the active provider's supervisor model from CONFIG.
 */
export function getSupervisorLLM(): BaseChatModel {
  const models = getActiveModels();
  return createLLM({
    model:       models.SUPERVISOR,
    jsonMode:    true,
    temperature: 0,
  });
}
