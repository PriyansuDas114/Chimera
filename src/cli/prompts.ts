import * as clack from "@clack/prompts";
import chalk from "chalk";
import * as path from "path";

// ─── Session Start ────────────────────────────────────────────────────────────

/**
 * Interactive session initialization flow.
 * Collects the working directory.
 * Returns null if the user cancels.
 */
export async function promptInitialization(
  defaultCwd: string
): Promise<{ cwd: string } | null> {
  clack.intro(
    chalk.hex("#7C3AED").bold(" ◈ Multi-Agent Engine ") +
    chalk.hex("#6B7280")("v0.1.0")
  );

  const cwdOverride = await clack.text({
    message: chalk.white("Working directory:"),
    placeholder: defaultCwd,
    initialValue: defaultCwd,
    validate(value) {
      if (!value || value.trim().length === 0) {
        return "Working directory cannot be empty.";
      }
    },
  });

  if (clack.isCancel(cwdOverride)) {
    clack.cancel("Session cancelled.");
    return null;
  }

  const resolvedCwd = path.resolve(String(cwdOverride));

  return {
    cwd: resolvedCwd,
  };
}

// ─── Spinner Wrapper ──────────────────────────────────────────────────────────

const activeSpinners = new Set<any>();
(global as any)._activeSpinners = activeSpinners;

let _isPromptActive = false;
Object.defineProperty(global, "isPromptActive", {
  get() {
    return _isPromptActive;
  },
  set(val: boolean) {
    if (_isPromptActive === val) return;
    _isPromptActive = val;
    if (val) {
      // Prompt is now active, stop all running spinners immediately
      for (const spinner of activeSpinners) {
        spinner._stopUnderlying();
      }
    } else {
      // Prompt is no longer active, resume spinners
      for (const spinner of activeSpinners) {
        spinner._startUnderlying();
      }
    }
  },
  configurable: true,
});

/**
 * Returns a clack spinner instance pre-configured for the engine.
 * The caller is responsible for calling .start() and .stop().
 */
export function createSpinner() {
  const s = clack.spinner();
  let activeMessage = "";
  let isStarted = false;
  let isUnderlyingRunning = false;

  const wrapper = {
    start(message?: string) {
      if (message !== undefined) activeMessage = message;
      isStarted = true;

      const globalActive = (global as any)._activeSpinners;
      if (globalActive) {
        globalActive.add(wrapper);
      }

      if (!(global as any).isPromptActive && !isUnderlyingRunning) {
        s.start(activeMessage);
        isUnderlyingRunning = true;
      }
    },
    stop(message?: string, code?: number) {
      isStarted = false;

      const globalActive = (global as any)._activeSpinners;
      if (globalActive) {
        globalActive.delete(wrapper);
      }

      s.stop(message, code);
      isUnderlyingRunning = false;
    },
    message(message?: string) {
      if (message !== undefined) activeMessage = message;
      if (!(global as any).isPromptActive) {
        s.message(activeMessage);
      }
    },
    _stopUnderlying() {
      if (isUnderlyingRunning) {
        s.stop("", 0);
        isUnderlyingRunning = false;
      }
    },
    _startUnderlying() {
      if (isStarted && !isUnderlyingRunning) {
        s.start(activeMessage);
        isUnderlyingRunning = true;
      }
    }
  };

  return wrapper;
}


// ─── Outro ────────────────────────────────────────────────────────────────────

export function showOutro(success: boolean): void {
  clack.outro(
    success
      ? chalk.hex("#059669").bold("✓ Session complete.")
      : chalk.hex("#DC2626").bold("✗ Session ended with errors.")
  );
}

// ─── Ollama Health Check ──────────────────────────────────────────────────────

/**
 * Prompts the user to confirm they want to continue if Ollama health
 * check fails. Returns false if they cancel.
 */
export async function promptOllamaRetry(): Promise<boolean> {
  const proceed = await clack.confirm({
    message: chalk.hex("#F59E0B")(
      "Ollama health check failed. Continue anyway? (models may not load)"
    ),
    initialValue: false,
  });

  if (clack.isCancel(proceed)) return false;
  return proceed === true;
}