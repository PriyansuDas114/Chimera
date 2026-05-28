import { BaseMessage } from "@langchain/core/messages";
import type { GraphStep } from "./runner.js";

interface StepSignature {
  type: "node" | "tool";
  name: string;
  payload: string; // Message content hash/preview or serialized tool args
}

export class LazyLoopDetector {
  private history: StepSignature[] = [];
  private fileWriteCount = 0;

  /**
   * Records a step in the execution history and checks if it constitutes a loop.
   * 
   * @param step - The graph step that just executed
   * @returns An object containing whether a loop was detected and a description of the loop.
   */
  public recordAndCheck(step: GraphStep): { detected: boolean; reason?: string } {
    const { nodeName, update } = step;

    // 1. Check if it's a tools node execution
    if (nodeName.startsWith("tools_")) {
      const lastMessage = update.messages?.at(-1);
      if (lastMessage && lastMessage._getType() === "tool") {
        const toolName = (lastMessage as any).name || nodeName.replace("tools_", "");
        const content = typeof lastMessage.content === "string" 
          ? lastMessage.content 
          : JSON.stringify(lastMessage.content);

        // Keep track of modifications to avoid false positives on test runs
        if (toolName === "write_file") {
          this.fileWriteCount++;
        }

        const signature: StepSignature = {
          type: "tool",
          name: toolName,
          payload: content.slice(0, 500), // Limit size for comparison
        };

        return this.addAndVerify(signature);
      }
    }

    // 2. Check if it's a worker agent execution
    const lastMessage = update.messages?.at(-1);
    if (lastMessage && lastMessage._getType() === "ai") {
      const aiMessage = lastMessage as any;
      
      // If the AI message has tool calls, register them as the signature
      if (Array.isArray(aiMessage.tool_calls) && aiMessage.tool_calls.length > 0) {
        for (const tc of aiMessage.tool_calls) {
          const sortedArgs = JSON.stringify(tc.args, Object.keys(tc.args).sort());
          const signature: StepSignature = {
            type: "tool",
            name: tc.name,
            payload: sortedArgs,
          };
          
          const result = this.addAndVerify(signature);
          if (result.detected) return result;
        }
      } else {
        // Plain text response from a worker
        const content = typeof aiMessage.content === "string" 
          ? aiMessage.content 
          : JSON.stringify(aiMessage.content);

        const signature: StepSignature = {
          type: "node",
          name: nodeName,
          payload: content.trim().slice(0, 200),
        };

        return this.addAndVerify(signature);
      }
    }

    return { detected: false };
  }

  private addAndVerify(signature: StepSignature): { detected: boolean; reason?: string } {
    this.history.push(signature);

    // We need at least 3 signatures to detect a loop
    if (this.history.length < 3) {
      return { detected: false };
    }

    // Heuristic 1: Identical consecutive/recent tool call loop (no file writes in between)
    // If we call the exact same tool with the exact same payload 3 times, and there were no
    // file writes in between that could change the state, it's a lazy loop.
    if (signature.type === "tool" && signature.name !== "write_file") {
      const matches = this.history.filter(
        (h) => h.type === "tool" && h.name === signature.name && h.payload === signature.payload
      );

      if (matches.length >= 3) {
        // Ensure no files were written between the first and last identical tool calls
        const firstIdx = this.history.findIndex(
          (h) => h.type === "tool" && h.name === signature.name && h.payload === signature.payload
        );
        const lastIdx = this.history.length - 1;
        
        const hasWriteInBetween = this.history
          .slice(firstIdx, lastIdx)
          .some((h) => h.type === "tool" && h.name === "write_file");

        if (!hasWriteInBetween) {
          return {
            detected: true,
            reason: `Identical tool execution loop detected: Agent called '${signature.name}' with the same arguments 3 times without modifying any files.`,
          };
        }
      }
    }

    // Heuristic 2: Worker Node Ping-Pong
    // If the exact same node name and similar message content repeats 3 times, it means the agent
    // is stuck in an unproductive chat loop.
    if (signature.type === "node") {
      const matches = this.history.filter(
        (h) => h.type === "node" && h.name === signature.name && this.isHighlySimilar(h.payload, signature.payload)
      );

      if (matches.length >= 3) {
        return {
          detected: true,
          reason: `Repetitive conversational cycle detected: Worker '${signature.name}' produced highly similar outputs 3 times.`,
        };
      }
    }

    // Heuristic 3: Periodic pattern repetition (e.g. A -> B -> C -> A -> B -> C -> A -> B -> C)
    // Detect periodic sequence repetitions of length 2, 3, or 4.
    for (let period = 2; period <= 4; period++) {
      if (this.history.length >= period * 3) {
        const len = this.history.length;
        let isPatternMatched = true;

        for (let i = 0; i < period; i++) {
          const sig1 = this.history[len - 1 - i];
          const sig2 = this.history[len - 1 - i - period];
          const sig3 = this.history[len - 1 - i - period * 2];

          if (
            !sig1 || !sig2 || !sig3 ||
            sig1.type !== sig2.type || sig2.type !== sig3.type ||
            sig1.name !== sig2.name || sig2.name !== sig3.name ||
            !this.isHighlySimilar(sig1.payload, sig2.payload) ||
            !this.isHighlySimilar(sig2.payload, sig3.payload)
          ) {
            isPatternMatched = false;
            break;
          }
        }

        if (isPatternMatched) {
          // Verify we didn't have write_file in the cycle to avoid halting productive iterations
          const cycleHasWrite = this.history
            .slice(len - period * 3)
            .some((h) => h.type === "tool" && h.name === "write_file");

          if (!cycleHasWrite) {
            const patternDesc = this.history
              .slice(len - period)
              .map((h) => `${h.type}:${h.name}`)
              .join(" -> ");
            return {
              detected: true,
              reason: `Repetitive sequence loop detected: The pattern [ ${patternDesc} ] repeated 3 times without making progress.`,
            };
          }
        }
      }
    }

    return { detected: false };
  }

  /**
   * Helper to check if two payloads are highly similar (Levenstein distance or simple substring comparison)
   */
  private isHighlySimilar(s1: string, s2: string): boolean {
    if (s1 === s2) return true;
    
    // Normalize string: lowercase, remove spaces and symbols
    const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const c1 = clean(s1);
    const c2 = clean(s2);

    if (c1 === c2) return true;
    
    // Substring match for short snippets
    if (c1.length > 10 && c2.length > 10) {
      if (c1.includes(c2) || c2.includes(c1)) return true;
    }

    return false;
  }
}
