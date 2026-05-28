import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";

// ─── LLM Config ──────────────────────────────────────────────────────────────

/**
 * Unified configuration passed to every provider adapter.
 * Each adapter maps these fields to its own SDK-specific options.
 */
export interface LLMConfig {
  /** Model identifier string (e.g. "llama3.1", "openai/gpt-4o", "anthropic/claude-3-5-sonnet") */
  model: string;
  /** Sampling temperature [0.0 – 2.0]. Lower = more deterministic. */
  temperature?: number;
  /** Maximum tokens to generate in a single completion. */
  maxTokens?: number;
  /** If true, return JSON-mode (forces the model to emit valid JSON). */
  jsonMode?: boolean;
  /** Tools to bind to this LLM instance. Empty array or undefined = no tool binding. */
  tools?: StructuredToolInterface[];
}

// ─── Provider Interface ───────────────────────────────────────────────────────

/**
 * Every LLM provider adapter must implement this interface.
 * The `createLLM` method receives a unified config and returns a
 * LangChain BaseChatModel ready for invocation (with tools bound if provided).
 */
export interface LLMProvider {
  /** Unique identifier for this provider (e.g. "ollama", "openrouter") */
  name: string;
  /**
   * Create a configured LLM instance.
   * If `config.tools` is non-empty, the returned model MUST have tools bound.
   */
  createLLM(config: LLMConfig): BaseChatModel;
  /**
   * Optional: check if the provider is reachable.
   * Returns true if healthy, false otherwise.
   */
  healthCheck?(): Promise<boolean>;
}
