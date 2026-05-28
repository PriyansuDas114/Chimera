import { ChatOllama } from "@langchain/ollama";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { LLMProvider, LLMConfig } from "./base.js";
import { CONFIG } from "../config/index.js";

// ─── Ollama Provider ──────────────────────────────────────────────────────────

export const ollamaProvider: LLMProvider = {
  name: "ollama",

  createLLM(config: LLMConfig): BaseChatModel {
    const llm = new ChatOllama({
      baseUrl: CONFIG.OLLAMA.BASE_URL,
      model: config.model,
      temperature: config.temperature ?? CONFIG.OLLAMA.DEFAULT_TEMPERATURE,
      ...(config.jsonMode ? { format: "json" } : {}),
      keepAlive: CONFIG.OLLAMA.KEEP_ALIVE as any,
      numCtx: CONFIG.OLLAMA.DEFAULT_NUM_CTX,
      numPredict: config.maxTokens ?? CONFIG.OLLAMA.DEFAULT_NUM_PREDICT,
    });

    if (config.tools && config.tools.length > 0) {
      return llm.bindTools(config.tools) as BaseChatModel;
    }

    return llm;
  },

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${CONFIG.OLLAMA.BASE_URL}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
