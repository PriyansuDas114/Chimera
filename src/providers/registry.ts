import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { LLMProvider, LLMConfig } from "./base.js";
import { ollamaProvider } from "./ollama.js";
import { openrouterProvider } from "./openrouter.js";
import { CONFIG } from "../config/index.js";

// ─── Provider Registry ────────────────────────────────────────────────────────

const PROVIDERS: Record<string, LLMProvider> = {
  ollama:      ollamaProvider,
  openrouter:  openrouterProvider,
};

// ─── Runtime Model Store ──────────────────────────────────────────────────────
//
// This is the LIVE state of the active provider + per-role models.
// Unlike CONFIG (frozen at startup), this can be mutated by `/model` at runtime.
// All agents read from here, not from CONFIG directly.

export type AgentRole = "supervisor" | "coder" | "auditor" | "researcher" | "qa";

interface RuntimeModelState {
  provider: string;
  models: Record<AgentRole, string>;
}

// Initialise from CONFIG at startup
function initRuntimeState(): RuntimeModelState {
  const provider = CONFIG.ACTIVE_PROVIDER;
  const src = provider === "openrouter" ? CONFIG.OPENROUTER.MODELS : CONFIG.OLLAMA.MODELS;
  return {
    provider,
    models: {
      supervisor: src.SUPERVISOR,
      coder:      src.CODER,
      auditor:    src.AUDITOR,
      researcher: src.RESEARCHER,
      qa:         src.QA,
    },
  };
}

const _runtime: RuntimeModelState = initRuntimeState();

// ─── Public Accessors ─────────────────────────────────────────────────────────

/** Get the currently active provider name. */
export function getActiveProvider(): string {
  return _runtime.provider;
}

/** Get the model assigned to a specific agent role. */
export function getModelForRole(role: AgentRole): string {
  return _runtime.models[role];
}

/** Get all current per-role model assignments. */
export function getAllRoleModels(): Record<AgentRole, string> {
  return { ..._runtime.models };
}

// ─── Mutators (used by /model command) ───────────────────────────────────────

/**
 * Switch ALL agent roles to a new provider + model.
 * Validates that the provider is registered and (for openrouter) an API key exists.
 * Returns an error string if validation fails, otherwise null.
 */
export function setAllModels(provider: string, model: string): string | null {
  if (!PROVIDERS[provider]) {
    return `Unknown provider "${provider}". Available: ${Object.keys(PROVIDERS).join(", ")}`;
  }
  if (provider === "openrouter" && !CONFIG.OPENROUTER.API_KEY) {
    return `OpenRouter API key is not set.\nAdd OPENROUTER_API_KEY=sk-or-v1-... to your .env file.\nGet a free key at: https://openrouter.ai/keys`;
  }
  _runtime.provider = provider;
  for (const role of Object.keys(_runtime.models) as AgentRole[]) {
    _runtime.models[role] = model;
  }
  return null;
}

/**
 * Switch a single agent role to a new provider + model.
 * Returns an error string if validation fails, otherwise null.
 */
export function setRoleModel(provider: string, role: AgentRole, model: string): string | null {
  if (!PROVIDERS[provider]) {
    return `Unknown provider "${provider}". Available: ${Object.keys(PROVIDERS).join(", ")}`;
  }
  if (provider === "openrouter" && !CONFIG.OPENROUTER.API_KEY) {
    return `OpenRouter API key is not set.\nAdd OPENROUTER_API_KEY=sk-or-v1-... to your .env file.\nGet a free key at: https://openrouter.ai/keys`;
  }
  if (!_runtime.models.hasOwnProperty(role)) {
    const valid = Object.keys(_runtime.models).join(", ");
    return `Unknown role "${role}". Valid roles: ${valid}`;
  }
  _runtime.provider = provider;
  _runtime.models[role] = model;
  return null;
}

// ─── Provider Access ─────────────────────────────────────────────────────────

/**
 * Get the active provider by name. Falls back to the runtime default.
 */
export function getProvider(name?: string): LLMProvider {
  const providerName = name ?? _runtime.provider;
  const provider = PROVIDERS[providerName];
  if (!provider) {
    throw new Error(
      `Unknown LLM provider: "${providerName}". ` +
      `Available providers: ${Object.keys(PROVIDERS).join(", ")}`
    );
  }
  return provider;
}

/**
 * Create an LLM using the active provider (or a specific override).
 * This is the single entry point used by all agents.
 */
export function createLLM(config: LLMConfig, providerOverride?: string): BaseChatModel {
  return getProvider(providerOverride ?? _runtime.provider).createLLM(config);
}

/**
 * Run the health check for the active provider.
 */
export async function checkProviderHealth(providerName?: string): Promise<boolean> {
  const provider = getProvider(providerName ?? _runtime.provider);
  if (provider.healthCheck) {
    return provider.healthCheck();
  }
  return true;
}

/**
 * Get display string: "model · provider" for the UI banner.
 */
export function getActiveProviderDisplay(): string {
  return `${_runtime.models.supervisor} · ${_runtime.provider}`;
}

/**
 * List all registered provider names, filtered by availability.
 * If hideUnconfigured=true, omits providers that are missing required config.
 */
export function listProviders(hideUnconfigured = false): string[] {
  const all = Object.keys(PROVIDERS);
  if (!hideUnconfigured) return all;
  return all.filter((p) => {
    if (p === "openrouter" && !CONFIG.OPENROUTER.API_KEY) return false;
    return true;
  });
}

// ─── Re-exports ────────────────────────────────────────────────────────────────

export type { LLMProvider, LLMConfig } from "./base.js";

