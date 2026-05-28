import chalk from "chalk";
import type { GraphStep } from "../graph/runner.js";
import type { AgentStateUpdate, AgentStatus, WorkerName } from "../graph/state.js";
import { AIMessage, SystemMessage, HumanMessage } from "@langchain/core/messages";
import { CONFIG } from "../config/index.js";

// ─── Theme ────────────────────────────────────────────────────────────────────

const theme = {
  // Node name colours
  supervisor:  chalk.hex("#F59E0B"),   // amber
  coder:       chalk.hex("#F97316"),   // orange
  auditor:     chalk.hex("#DC2626"),   // crimson
  researcher:  chalk.hex("#EF4444"),   // bright red
  qa:          chalk.hex("#FCA5A5"),   // rose
  tools:       chalk.hex("#7F1D1D"),   // deep rust
  system:      chalk.hex("#991B1B"),   // burgundy

  // Status pill colours
  planning:    chalk.hex("#F59E0B").bold,
  coding:      chalk.hex("#F97316").bold,
  testing:     chalk.hex("#FCA5A5").bold,
  reviewing:   chalk.hex("#DC2626").bold,
  awaiting:    chalk.hex("#B91C1C").bold,
  finished:    chalk.hex("#84CC16").bold,

  // UI chrome
  border:      chalk.hex("#F97316"),   // orange borders
  dim:         chalk.hex("#B91C1C"),   // dim burgundy text
  subdued:     chalk.hex("#7F1D1D"),   // even dimmer rust
  success:     chalk.hex("#84CC16"),   // warm lime green success
  error:       chalk.hex("#EF4444"),   // keep red for actual errors
  warn:        chalk.hex("#F59E0B"),   // amber warning
  muted:       chalk.hex("#991B1B"),   // muted burgundy
  accent:      chalk.hex("#F97316"),   // primary orange accent
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function terminalWidth(): number {
  return process.stdout.columns ?? 80;
}

function divider(char = "─"): string {
  return theme.border(char.repeat(Math.min(terminalWidth(), 72)));
}

function timestamp(): string {
  return theme.dim(new Date().toLocaleTimeString("en-US", { hour12: false }));
}

function nodeColour(nodeName: string): typeof chalk {
  if (nodeName.startsWith("tools_")) return theme.tools;
  if (nodeName === "supervisor")     return theme.supervisor;
  if (nodeName === "coder")          return theme.coder;
  if (nodeName === "auditor")        return theme.auditor;
  if (nodeName === "researcher")     return theme.researcher;
  if (nodeName === "qa")             return theme.qa;
  return theme.system;
}

function nodeLabel(nodeName: string): string {
  const colour = nodeColour(nodeName);
  const icon = nodeIcon(nodeName);
  return colour.bold(`${icon} ${nodeName.toUpperCase()}`);
}

function nodeIcon(nodeName: string): string {
  if (nodeName.startsWith("tools_")) return "⚙";
  switch (nodeName) {
    case "supervisor":  return "◈";
    case "coder":       return "⌨";
    case "auditor":     return "◎";
    case "researcher":  return "⌕";
    case "qa":          return "✦";
    default:            return "·";
  }
}

function statusBadge(status?: AgentStatus): string {
  if (!status) return "";
  switch (status) {
    case "PLANNING":          return theme.planning(" PLANNING ");
    case "CODING":            return theme.coding(" CODING ");
    case "TESTING":           return theme.testing(" TESTING ");
    case "REVIEWING":         return theme.reviewing(" REVIEWING ");
    case "AWAITING_APPROVAL": return theme.awaiting(" AWAITING ");
    case "FINISHED":          return theme.finished(" ✓ DONE ");
  }
}

function workerBadge(worker: WorkerName): string {
  if (!worker) return theme.muted("→ none");
  return theme.muted("→ ") + nodeColour(worker).bold(worker);
}

// ─── Message Excerpt ──────────────────────────────────────────────────────────

/**
 * Extracts a short readable preview from the last message in a state update.
 * Truncates to keep the terminal output scannable.
 */
function extractMessagePreview(update: AgentStateUpdate): string | null {
  const messages = update.messages;
  if (!messages || messages.length === 0) return null;

  const last = messages[messages.length - 1];
  if (!last) return null;

  const raw =
    typeof last.content === "string"
      ? last.content
      : JSON.stringify(last.content);

  // Strip orchestrator header lines for cleaner display
  const stripped = raw
    .replace(/^\[.*?\]\n/gm, "")
    .replace(/^(Instructions|Reasoning):\s*/gm, "")
    .trim();

  const maxLen = Math.min(terminalWidth() - 8, 200);
  if (stripped.length <= maxLen) return stripped;
  return stripped.slice(0, maxLen) + theme.dim("…");
}

function messageTypeTag(update: AgentStateUpdate): string {
  const messages = update.messages;
  if (!messages || messages.length === 0) return "";

  const last = messages[messages.length - 1];
  if (!last) return "";

  const type = typeof last._getType === "function" 
    ? last._getType() 
    : (last as any).type || (last.constructor ? last.constructor.name : "");

  if (type === "human" || type === "HumanMessage") return theme.muted(" [human]");
  if (type === "ai" || type === "AIMessage") {
    const hasToolCalls =
      Array.isArray((last as any).tool_calls) && (last as any).tool_calls.length > 0;
    return hasToolCalls
      ? theme.warn(" [tool-call]")
      : theme.muted(" [ai]");
  }
  if (type === "system" || type === "SystemMessage") return theme.dim(" [system]");
  return theme.muted(" [tool-result]");
}

// ─── Public Renderer Functions ────────────────────────────────────────────────

export function renderBanner(sessionId?: string, cwd?: string): void {
  const v = "0.1.0";

  const orange = chalk.hex("#F97316");
  const burgundy = chalk.hex("#991B1B");
  const amber = chalk.hex("#F59E0B");
  const rust = chalk.hex("#7F1D1D");

  console.log();

  // ── CHIMERA Blocky Title ─────────────────────────────────────────────────────
  console.log(orange.bold(" ██████╗██╗  ██╗██╗███╗   ███╗███████╗██████╗  █████╗ "));
  console.log(orange.bold("██╔════╝██║  ██║██║████╗ ████║██╔════╝██╔══██╗██╔══██╗"));
  console.log(orange.bold("██║     ███████║██║██╔████╔██║█████╗  ██████╔╝███████║"));
  console.log(orange.bold("██║     ██╔══██║██║██║╚██╔╝██║██╔══╝  ██╔══██╗██╔══██║"));
  console.log(orange.bold("╚██████╗██║  ██║██║██║ ╚═╝ ██║███████╗██║  ██║██║  ██║"));
  console.log(orange.bold(" ╚═════╝╚═╝  ╚═╝╚═╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝"));
  console.log();

  // ── Info Card (Two Columns) ──────────────────────────────────────────────────
  const titleText = ` CHIMERA v${v} (local-first) `;
  const contentWidth = 84;
  const totalW = contentWidth + 4;
  const leftW = 36;
  const rightW = contentWidth - leftW;

  const barCount = totalW - 2 - titleText.length;
  const barCountLeft = Math.floor(barCount / 2);
  const barCountRight = barCount - barCountLeft;
  const topBorder = orange(`┌${"─".repeat(barCountLeft)}${amber(titleText)}${orange("─".repeat(barCountRight))}┐`);
  console.log(topBorder);

  // Rows of the two column layout
  // Column 1 (Left): Chimera beast ASCII art + env info
  // Column 2 (Right): Available Agents + Available Tools

  const leftLines = [
    orange("\u2800".repeat(8) + "⢀⣀⡀" + "\u2800".repeat(6) + "⢀⣀⡀" + "\u2800".repeat(8)),
    orange("\u2800".repeat(9) + "⠻⣿⣿⡆" + "\u2800".repeat(2) + "⢰⣿⣿⠟" + "\u2800".repeat(9)),
    orange("\u2800".repeat(10) + "⢹⣿⣿⣾⣷⣿⣿⡏" + "\u2800".repeat(10)),
    orange("\u2800".repeat(9) + "⢀⣾⣿⣿⣿⣿⣿⣿⣷⡀" + "\u2800".repeat(9)),
    orange("\u2800".repeat(9) + "⣴⣿⣿⡿⠋⠙⢿⣿⣿⣦" + "\u2800".repeat(9)),
    orange("\u2800".repeat(8) + "⢾⣿⣿⠏\u2800⢶⡶\u2800⠹⣿⣿⡷" + "\u2800".repeat(8)),
    orange("\u2800".repeat(8) + "⠘⣿⣿⣆\u2800⠶⠶\u2800⣰⣿⣿⠃" + "\u2800".repeat(8)),
    orange("\u2800".repeat(9) + "⠙⢿⣿⣿⣶⣶⣿⣿⡿⠋" + "\u2800".repeat(9)),
    orange("\u2800".repeat(11) + "⢻⣿⣿⣿⣿⡟" + "\u2800".repeat(11)),
    orange("\u2800".repeat(11) + "⠙⢿⣿⣿⡿⠋" + "\u2800".repeat(11)),
    "",
    amber(`${CONFIG.ACTIVE_PROVIDER === "openrouter" ? CONFIG.OPENROUTER.MODELS.SUPERVISOR : CONFIG.OLLAMA.MODELS.SUPERVISOR}`.slice(0, leftW - 12)) + rust(` · ${CONFIG.ACTIVE_PROVIDER}`),
    rust((cwd || process.cwd()).slice(0, leftW - 2)),
    rust(`Session: ${sessionId || "New Session"}`.slice(0, leftW - 2))
  ];

  const rightLines = [
    amber("Available Agents"),
    burgundy("supervisor: ") + rust("delegates tasks"),
    burgundy("coder:      ") + rust("writes/edits code"),
    burgundy("researcher: ") + rust("finds/analyzes context"),
    burgundy("qa:         ") + rust("tests/validates code"),
    burgundy("auditor:    ") + rust("reviews/secures code"),
    "",
    amber("Available Tools"),
    burgundy("file:     ") + rust("read_file, write_file, patch_file"),
    burgundy("system:   ") + rust("list_dir, search_codebase"),
    burgundy("orchestr: ") + rust("execute_task (delegation)")
  ];

  const maxLines = Math.max(leftLines.length, rightLines.length);
  
  for (let i = 0; i < maxLines; i++) {
    const leftRaw = leftLines[i] || "";
    // strip ansi to pad correctly
    const leftStrip = leftRaw.replace(/\x1b\[[0-9;]*m/g, "");
    const leftPad = leftRaw + " ".repeat(Math.max(0, leftW - leftStrip.length));

    const rightRaw = rightLines[i] || "";
    const rightStrip = rightRaw.replace(/\x1b\[[0-9;]*m/g, "");
    const rightPad = rightRaw + " ".repeat(Math.max(0, rightW - rightStrip.length));

    console.log(orange("│ ") + leftPad + rightPad + orange(" │"));
  }

  // Bottom footer of box
  const bottomFooterText = "  6 agents · 6 tools · Type /help for commands  ";
  const bottomBarCount = totalW - 3 - bottomFooterText.length;
  console.log(orange(`└─${rust(bottomFooterText)}${"─".repeat(Math.max(0, bottomBarCount))}┘`));
  console.log();
}


/**
 * Formats a single graph step into an array of styled string lines.
 */
export function formatStep(step: GraphStep, stepIndex: number): string[] {
  const { nodeName, update, timestamp: ts } = step;
  const lines: string[] = [];
  const colour = nodeColour(nodeName);
  const icon   = nodeIcon(nodeName);
  const time   = theme.dim(new Date(ts).toLocaleTimeString("en-US", { hour12: false }));

  // ── Step header ─────────────────────────────────────────────────────────────
  const stepNum  = theme.subdued(`  ${String(stepIndex).padStart(2, "0")}`);
  const label    = colour.bold(` ${icon} ${nodeName.toUpperCase()}`);
  const badge    = update.status ? ` ${statusBadge(update.status)}` : "";
  const worker   = update.activeWorker ? theme.dim(" → ") + colour(update.activeWorker) : "";

  lines.push(`${stepNum}  ${label}${badge}${worker}  ${time}`);

  // ── Message preview ─────────────────────────────────────────────────────────
  const preview = extractMessagePreview(update);
  if (preview) {
    const tag      = messageTypeTag(update);
    const msgLines = preview.split("\n").slice(0, 3); // max 3 lines
    const pipe     = theme.subdued("     │ ");
    for (const line of msgLines) {
      if (line.trim()) {
        lines.push(pipe + theme.muted(line.slice(0, 120)));
      }
    }
    if (tag) {
      lines.push(theme.subdued("     └") + tag);
    }
  }

  // ── Error log notification ──────────────────────────────────────────────────
  if (update.errorLogs && update.errorLogs.length > 0) {
    for (const err of update.errorLogs) {
      lines.push(
        theme.subdued("     ✖ ") +
        theme.error(err.slice(0, 120))
      );
    }
  }

  // ── Tool call detail ────────────────────────────────────────────────────────
  if (nodeName.startsWith("tools_")) {
    const last = update.messages?.at(-1);
    if (last && typeof last.content === "string") {
      const toolLines = last.content.split("\n").slice(0, 3);
      const pipe      = theme.subdued("     │ ");
      for (const line of toolLines) {
        if (line.trim()) {
          lines.push(pipe + theme.warn(line.slice(0, 110)));
        }
      }
    }
  }

  return lines;
}

/**
 * Renders a single graph step as it arrives from the onStep callback.
 * Called once per node execution during graph streaming.
 */
export function renderStep(step: GraphStep, stepIndex: number): void {
  const lines = formatStep(step, stepIndex);
  for (const line of lines) {
    console.log(line);
  }
}

/**
 * Renders the final session summary after graph execution completes.
 */
export function renderSummary(options: {
  sessionId: string;
  stepCount: number;
  success: boolean;
  errorLogs: string[];
  durationMs: number;
}): void {
  const { sessionId, stepCount, success, errorLogs, durationMs } = options;

  console.log();
  console.log(divider("─"));
  console.log();

  if (success) {
    console.log(
      "  " + theme.success("✓ TASK COMPLETED") +
      theme.dim(`  ${stepCount} steps · ${(durationMs / 1000).toFixed(1)}s`)
    );
  } else {
    console.log(
      "  " + theme.error("✗ TASK FAILED") +
      theme.dim(`  ${stepCount} steps · ${(durationMs / 1000).toFixed(1)}s`)
    );
  }

  console.log(theme.dim(`  Session: ${sessionId}`));

  if (errorLogs.length > 0) {
    console.log();
    console.log("  " + theme.error("Error log:"));
    for (const err of errorLogs) {
      console.log(theme.dim("  · ") + theme.error(err));
    }
  }

  console.log();
  console.log(divider("─"));
  console.log();
}

/**
 * Renders a fatal startup error (e.g., Ollama not running).
 */
export function renderFatalError(message: string, hint?: string): void {
  console.log();
  console.log("  " + theme.error("✗ FATAL: ") + chalk.white(message));
  if (hint) {
    console.log("  " + theme.warn("  hint: ") + theme.dim(hint));
  }
  console.log();
}

/**
 * Parses advanced Markdown syntax and returns a string styled with Chalk
 * for terminal display.
 */
export function renderMarkdown(text: string): string {
  const stream = new LiveMarkdownStream(true);
  stream.write(text);
  stream.end();
  return stream.getBuffer();
}

/**
 * Premium Syntax Highlighting functions for specific languages.
 */
function highlightJS(code: string): string {
  const tokens: { [key: string]: string } = {};
  let tokenCounter = 0;
  let codeWithTokens = code;

  // 1. Hide comments and strings to protect them from keyword matching
  const stringAndCommentRegex = /(\/\*[\s\S]*?\*\/|\/\/.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g;
  codeWithTokens = codeWithTokens.replace(stringAndCommentRegex, (match) => {
    const tokenId = `__JS_TOKEN_${tokenCounter++}__`;
    if (match.startsWith("//") || match.startsWith("/*")) {
      tokens[tokenId] = chalk.hex("#6B7280").italic(match); // comment
    } else {
      tokens[tokenId] = chalk.hex("#10B981")(match); // string
    }
    return tokenId;
  });

  // 2. Highlight keywords, types, builtins
  const keywords = /\b(const|let|var|function|class|interface|type|return|import|export|from|as|new|await|async|if|else|for|while|switch|case|default|break|continue|try|catch|finally|throw|extends|implements|super|this|typeof|instanceof)\b/g;
  codeWithTokens = codeWithTokens.replace(keywords, chalk.hex("#F43F5E").bold("$1"));

  const types = /\b(string|number|boolean|any|void|unknown|never|Promise|Record|Array|object|undefined|null|true|false)\b/g;
  codeWithTokens = codeWithTokens.replace(types, chalk.hex("#60A5FA")("$1"));

  const builtins = /\b(console|log|error|warn|process|env|Math|JSON|Object|Array|String|Number|Boolean|Date|Error|RegExp|Map|Set|Promise|resolve|reject)\b/g;
  codeWithTokens = codeWithTokens.replace(builtins, chalk.hex("#2DD4BF")("$1"));

  // Function calls / declarations
  codeWithTokens = codeWithTokens.replace(/\b(\w+)(?=\s*\()/g, chalk.hex("#A78BFA")("$1"));

  // Numbers
  codeWithTokens = codeWithTokens.replace(/\b(\d+(?:\.\d+)?)\b/g, chalk.hex("#F59E0B")("$1"));

  // 3. Restore strings and comments
  for (const [tokenId, value] of Object.entries(tokens)) {
    codeWithTokens = codeWithTokens.replace(tokenId, value);
  }

  return codeWithTokens;
}

function highlightShell(code: string): string {
  const tokens: { [key: string]: string } = {};
  let tokenCounter = 0;
  let codeWithTokens = code;

  // 1. Hide comments and strings
  const stringAndCommentRegex = /(#.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
  codeWithTokens = codeWithTokens.replace(stringAndCommentRegex, (match) => {
    const tokenId = `__SHELL_TOKEN_${tokenCounter++}__`;
    if (match.startsWith("#")) {
      tokens[tokenId] = chalk.hex("#6B7280").italic(match);
    } else {
      tokens[tokenId] = chalk.hex("#10B981")(match);
    }
    return tokenId;
  });

  // 2. Highlight package managers, common commands, args
  const commands = /\b(npm|npx|node|git|tsc|eslint|cd|ls|pwd|mkdir|rm|cp|mv|cat|grep|echo|chmod|chimera|tsx)\b/g;
  codeWithTokens = codeWithTokens.replace(commands, chalk.hex("#2DD4BF").bold("$1"));

  const options = /(\s-[a-zA-Z0-9-]+|\s--[a-zA-Z0-9-]+)/g;
  codeWithTokens = codeWithTokens.replace(options, chalk.hex("#60A5FA")("$1"));

  // 3. Restore strings and comments
  for (const [tokenId, value] of Object.entries(tokens)) {
    codeWithTokens = codeWithTokens.replace(tokenId, value);
  }

  return codeWithTokens;
}

function highlightGeneral(code: string): string {
  const tokens: { [key: string]: string } = {};
  let tokenCounter = 0;
  let codeWithTokens = code;

  // Hide strings
  const stringRegex = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
  codeWithTokens = codeWithTokens.replace(stringRegex, (match) => {
    const tokenId = `__GEN_TOKEN_${tokenCounter++}__`;
    tokens[tokenId] = chalk.hex("#10B981")(match);
    return tokenId;
  });

  // Generic keywords
  const genericKeywords = /\b(class|struct|def|fn|function|return|import|export|from|if|else|for|while|try|catch|true|false|null|nil)\b/g;
  codeWithTokens = codeWithTokens.replace(genericKeywords, chalk.hex("#F43F5E").bold("$1"));

  // Restore strings
  for (const [tokenId, value] of Object.entries(tokens)) {
    codeWithTokens = codeWithTokens.replace(tokenId, value);
  }

  return codeWithTokens;
}

/**
 * Formats a general markdown line with lists, bolding, blockquotes, inline code.
 */
function renderMarkdownLine(line: string): string {
  let rendered = line;

  // 1. Headers (### Header)
  rendered = rendered.replace(/^#{1,3}\s?(.*$)/, (_, content) => {
    return "\n" + theme.supervisor.bold.underline(content.trim().toUpperCase()) + "\n";
  });

  // 2. Bullet points (* item)
  rendered = rendered.replace(/^(\s*)[*+-]\s?(.*$)/, (_, indent, content) => {
    return `${indent}  - ${content.trim()}`;
  });

  // 3. Numbered lists (1. item)
  rendered = rendered.replace(/^(\s*)\d+\.\s?(.*$)/, (_, indent, content) => {
    return `${indent}  • ${content.trim()}`;
  });

  // 4. Blockquotes (> comment)
  rendered = rendered.replace(/^>\s?(.*$)/, (_, content) => {
    return `  ${chalk.hex("#4B5563").italic("│")} ${chalk.hex("#9CA3AF").italic(content)}`;
  });

  // 5. Bold (**text**)
  rendered = rendered.replace(/\*\*(.*?)\*\*/g, (_, content) => {
    return chalk.bold(content);
  });

  // 6. Italics (*text*)
  rendered = rendered.replace(/\*(.*?)\*/g, (_, content) => {
    return chalk.italic(content);
  });

  // 7. Inline code (`code`)
  rendered = rendered.replace(/`(.*?)`/g, (_, content) => {
    return chalk.hex("#F59E0B").bgHex("#1E293B").bold(` ${content} `);
  });

  return rendered;
}

/**
 * Professional real-time Line-Buffered Markdown stream formatter.
 */
export class LiveMarkdownStream {
  private lineBuffer = "";
  private isInsideCodeBlock = false;
  private codeBlockLang = "";
  private width = 76;
  private formattedBuffer: string[] = [];
  private silent: boolean;

  constructor(silent = false) {
    this.silent = silent;
  }

  public write(chunk: string): void {
    this.lineBuffer += chunk;
    
    if (this.lineBuffer.includes("\n")) {
      const lines = this.lineBuffer.split("\n");
      this.lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        this.processLine(line);
      }
    }
  }

  public end(): void {
    if (this.lineBuffer) {
      this.processLine(this.lineBuffer);
      this.lineBuffer = "";
    }
    if (this.isInsideCodeBlock) {
      const bottomBorder = chalk.hex("#4B5563")("  └" + "─".repeat(this.width));
      this.output(bottomBorder);
      this.isInsideCodeBlock = false;
    }
  }

  public getBuffer(): string {
    return this.formattedBuffer.join("\n");
  }

  private output(text: string): void {
    if (this.silent) {
      this.formattedBuffer.push(text);
    } else {
      process.stdout.write(text + "\n");
    }
  }

  private processLine(line: string): void {
    const trimmed = line.trim();

    // Code block toggle
    if (trimmed.startsWith("```")) {
      this.isInsideCodeBlock = !this.isInsideCodeBlock;
      
      if (this.isInsideCodeBlock) {
        this.codeBlockLang = trimmed.slice(3).trim().toLowerCase();
        const labelLen = this.codeBlockLang ? this.codeBlockLang.length + 9 : 13;
        const repeatCount = Math.max(0, this.width - labelLen);
        const topBorder = chalk.hex("#4B5563")(
          `  ┌── [${this.codeBlockLang || "code"}] ` + "─".repeat(repeatCount)
        );
        this.output(topBorder);
      } else {
        const bottomBorder = chalk.hex("#4B5563")("  └" + "─".repeat(this.width));
        this.output(bottomBorder);
      }
      return;
    }

    if (this.isInsideCodeBlock) {
      const sideBorder = chalk.hex("#4B5563")("  │ ");
      let highlightedLine = line;

      if (["javascript", "typescript", "js", "ts", "json"].includes(this.codeBlockLang)) {
        highlightedLine = highlightJS(line);
      } else if (["bash", "sh", "zsh", "shell", "powershell", "ps1"].includes(this.codeBlockLang)) {
        highlightedLine = highlightShell(line);
      } else {
        highlightedLine = highlightGeneral(line);
      }

      this.output(`${sideBorder}${highlightedLine}`);
    } else {
      this.output(renderMarkdownLine(line));
    }
  }
}

// ─── Persistent Session Helpers ───────────────────────────────────────────────

/**
 * Renders a visual separator between turns in a persistent session REPL.
 * Prints something like:
 *
 *   ─────────────────────────────────────────────────────
 *    TURN 2  ·  "Now add error handling to math.ts"
 *   ─────────────────────────────────────────────────────
 */
export function renderTurnHeader(turn: number, goal: string): void {
  const width  = Math.min(terminalWidth() - 4, 76);
  const bar    = chalk.hex("#1F2937")("─".repeat(width));
  const turnTag = chalk.hex("#7C3AED").bold(`TURN ${turn}`);
  const sep     = chalk.hex("#374151")(" · ");
  const goalStr = goal.length > 55 ? goal.slice(0, 52) + "…" : goal;
  const label   = `  ${turnTag}${sep}${chalk.hex("#D1D5DB")(goalStr)}`;

  console.log();
  console.log(`  ${bar}`);
  console.log(label);
  console.log(`  ${bar}`);
  console.log();
}