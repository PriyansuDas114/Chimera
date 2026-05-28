import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { LLMProvider, LLMConfig } from "./base.js";
import { CONFIG } from "../config/index.js";

// ─── OpenRouter Provider ──────────────────────────────────────────────────────
//
// OpenRouter exposes an OpenAI-compatible REST API at https://openrouter.ai/api/v1
// so we can use @langchain/openai's ChatOpenAI with a custom baseURL and apiKey.
//
// Model names use the provider/model format, e.g.:
//   "openai/gpt-4o"
//   "anthropic/claude-3-5-sonnet"
//   "meta-llama/llama-3.1-70b-instruct"
//   "google/gemini-2.0-flash"
//   "mistralai/mistral-7b-instruct"

export const openrouterProvider: LLMProvider = {
  name: "openrouter",

  createLLM(config: LLMConfig): BaseChatModel {
    const apiKey = CONFIG.OPENROUTER.API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is not set. Please add it to your .env file.\n" +
        "Get a free key at: https://openrouter.ai/keys"
      );
    }

    const llm = new ChatOpenAI({
      openAIApiKey: apiKey,
      modelName: config.model,
      temperature: config.temperature ?? 0.15,
      ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
      configuration: {
        baseURL: CONFIG.OPENROUTER.BASE_URL,
        defaultHeaders: {
          "HTTP-Referer": "https://github.com/chimera-agent",
          "X-Title": "CHIMERA Multi-Agent Engine",
        },
      },
    });

    if (config.tools && config.tools.length > 0) {
      return llm.bindTools(config.tools) as BaseChatModel;
    }

    return llm;
  },

  async healthCheck(): Promise<boolean> {
    try {
      const apiKey = CONFIG.OPENROUTER.API_KEY;
      if (!apiKey) return false;
      const res = await fetch(`${CONFIG.OPENROUTER.BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
