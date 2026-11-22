import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import * as zlib from "node:zlib";
import { codexQuery } from "./chat-threads.ts";

// One agent chat session read in full from its local log, for the session overlay: every model request with its token
// use, every tool call, the user's messages, model and effort changes, compactions and the subagents it started.
// Claude Code writes ~/.claude/projects/<folder>/<session>.jsonl, with each Agent-tool subagent in
// <session>/subagents/agent-<id>.jsonl beside a .meta.json. Codex writes ~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl,
// one file per thread; a subagent is its own thread whose parent is in the state database.
// Token convention for both: `input` is the whole prompt the model read, `cached` the part read from the prompt cache,
// `cacheWrite` the part written to it. So input - cached is what the request paid full price (or more) for.

type JSONObject = Record<string, any>;
export type Request = { agent: number; t: number; model: string; effort?: string; input: number; cached: number; cacheWrite: number;
  output: number; reasoning: number; cost: number | null; stop?: string; thinkingMs?: number; window?: number; text?: string };
export type Tool = { id: string; agent: number; t: number; request: number; name: string; args: string; result: string; size: number;
  error: boolean; dur: number | null; via?: string; spawns?: number };
export type Message = { agent: number; t: number; text: string };
export type Mark = { agent: number; t: number; kind: "compact" | "model" | "effort"; label: string; before?: number; after?: number; trigger?: string };
export type Agent = { label: string; type?: string; description?: string; model?: string; start: number; end: number };
export type Session = { key: string; provider: "Claude" | "Codex"; title: string; cwd: string; branch: string; path: string; url: string;
  start: number; end: number; cost: number | null; costExact: boolean;
  agents: Agent[]; requests: Request[]; tools: Tool[]; messages: Message[]; marks: Mark[] };

const ARGS = 1500;
const RESULT = 1500;
const MESSAGE = 4000;
const SAID = 2000;
const string = (value: unknown) => typeof value === "string" ? value : "";
const int = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0;
const clip = (text: string, size: number) => text.length > size ? `${text.slice(0, size - 1)}…` : text;
const json = (value: unknown) => typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);
// Clips each long string inside a call's arguments, so the arguments stay valid JSON the overlay can lay out.
const clipArgs = (value: unknown): string => {
  if (typeof value === "string") { try { const parsed = JSON.parse(value); if (parsed && typeof parsed === "object") return clipArgs(parsed); } catch { /* plain text */ } return clip(value, ARGS); }
  const walk = (item: unknown): unknown => typeof item === "string" ? clip(item, ARGS) : Array.isArray(item) ? item.map(walk)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)])) : item;
  return json(walk(value));
};
const said = (row: Request, text: string) => { if (text.trim()) row.text = clip([row.text, text.trim()].filter(Boolean).join("\n\n"), SAID); };
const time = (value: unknown) => { const at = Date.parse(string(value)); return Number.isFinite(at) ? at : 0; };
const lines = (text: string) => {
  const out: JSONObject[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* A log being written can end mid-line. */ }
  }
  return out;
};
// Codex compresses archived rollouts with zstd, which Node reads from 22.15 on.
async function readLog(path: string) {
  const data = await readFile(path);
  if (!path.endsWith(".zst")) return data.toString("utf8");
  const unzip = (zlib as JSONObject).zstdDecompressSync;
  return unzip ? unzip(data).toString("utf8") : "";
}
async function list(path: string) {
  try { return await readdir(path); } catch { return []; }
}
async function exists(path: string) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

// Anthropic prices every token type as a multiple of the model's input price: output 5×, a 5-minute cache write 1.25×,
// a 1-hour write 2×, a cache read 0.1×. So a request's cost is the input price times its weighted tokens.
// Claude Code's cost-state record gives each model's real total, which yields its exact price; without one, the input
// price comes from this table (USD per million input tokens, by tier). Codex models use OpenAI API prices: input,
// cached input, output. A model not listed has no cost.
export const claudeUnits = (fresh: number, cached: number, write5m: number, write1h: number, output: number) =>
  fresh + output * 5 + write5m * 1.25 + write1h * 2 + cached * 0.1;
const CLAUDE_PRICES: [string, number][] = [["claude-opus-4-1", 15], ["claude-3-5-haiku", 0.8], ["fable", 10], ["opus", 5], ["sonnet", 3], ["haiku", 1]];
const CODEX_PRICES: Record<string, number[]> = {
  "gpt-5.5": [5, 0.5, 30], "gpt-5.4": [2.5, 0.25, 15], "gpt-5.4-mini": [0.75, 0.075, 4.5], "gpt-5.4-nano": [0.2, 0.02, 1.25],
  "gpt-5.3-codex": [1.75, 0.175, 14], "gpt-5-codex": [1.75, 0.175, 14], "codex-mini-latest": [1.75, 0.175, 14],
};
export function claudeCost(model: string, units: number) {
  const price = CLAUDE_PRICES.find(([name]) => model.toLowerCase().includes(name))?.[1];
  return price ? units * price / 1e6 : null;
}
// Each Claude request's weighted tokens, kept off the payload.
const UNITS = new WeakMap<Request, number>();
// USD per weighted token for each model in a cost-state record's modelUsage.
function claudeRates(usage: JSONObject) {
  const rates = new Map<string, number>();
  for (const [model, row] of Object.entries(usage || {}) as [string, JSONObject][]) {
    const write1h = int(row.cacheCreationEphemeral1hInputTokens);
    const write5m = int(row.cacheCreationEphemeral5mInputTokens) || Math.max(0, int(row.cacheCreationInputTokens) - write1h);
    const units = claudeUnits(int(row.inputTokens), int(row.cacheReadInputTokens), write5m, write1h, int(row.outputTokens));
    if (units && Number(row.costUSD) > 0) rates.set(model, Number(row.costUSD) / units);
  }
  return rates;
}
export function codexCost(model: string, input: number, cached: number, output: number) {
  const price = CODEX_PRICES[model.toLowerCase().replace(/-20\d\d-\d\d-\d\d$/, "")];
  if (!price) return null;
  return ((input - cached) * price[0] + cached * price[1] + output * price[2]) / 1e6;
}

// ---------- Claude Code ----------

// Wrapper turns Claude Code adds around slash commands and `!` shell runs, and context it injects, are not typed input.
const NOISE = /^\s*<(?:local-command-caveat|command-name|command-message|command-args|local-command-std(?:out|err)|bash-(?:input|std(?:out|err))|task-notification|system-reminder)>/;
const contentText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((block) => block?.type === "text" ? string(block.text) : block?.type === "image" ? "[image]" : block?.type === "tool_reference" ? `[${string(block.tool_name)}]` : "").filter(Boolean).join("\n") : "";

// `calls` maps each tool call ID to its row, shared across files so a subagent's metadata can name the call that started it.
function readClaude(records: JSONObject[], agent: number, session: Session, calls: Map<string, number>, desktopEffort = "") {
  const requests = new Map<string, number>();
  let model = "";
  let effort = desktopEffort;
  let cost: number | null = null;
  let rates = new Map<string, number>();
  let first = 0;
  let last = 0;
  for (const record of records) {
    const t = time(record.timestamp);
    if (t) { first ||= t; last = Math.max(last, t); }
    const lane = record.isSidechain && agent === 0 ? sidechain(session) : agent;
    const message = record.message && typeof record.message === "object" ? record.message : {};
    if (record.type === "cost-state") {
      if (agent === 0) cost = Number(record.totalCostUSD) || cost;
      rates = claudeRates(record.modelUsage);
    }
    if (agent === 0 && !session.cwd && record.cwd) session.cwd = string(record.cwd);
    if (agent === 0 && !session.branch && record.gitBranch && record.gitBranch !== "HEAD") session.branch = string(record.gitBranch);
    if (agent === 0 && (record.type === "custom-title" || record.type === "ai-title")) session.title = string(record.customTitle || record.aiTitle) || session.title;
    if (record.type === "system" && record.subtype === "compact_boundary") {
      const meta = record.compactMetadata || {};
      session.marks.push({ agent: lane, t, kind: "compact", label: "Compacted", trigger: string(meta.trigger) || undefined,
        before: int(meta.preTokens) || undefined, after: int(meta.postTokens) || undefined });
      continue;
    }
    if (record.type === "assistant") {
      const id = string(record.requestId || message.id);
      const usage = message.usage;
      const named = string(message.model);
      if (named && named !== "<synthetic>" && named !== model) {
        if (model) session.marks.push({ agent: lane, t, kind: "model", label: named });
        model = named;
      }
      const turnEffort = string(record.perTurnEffort || record.effort);
      if (turnEffort && turnEffort !== effort) {
        if (effort) session.marks.push({ agent: lane, t, kind: "effort", label: turnEffort });
        effort = turnEffort;
      }
      let index = requests.get(id);
      if (usage && id && named !== "<synthetic>") {
        const fresh = int(usage.input_tokens);
        const cached = int(usage.cache_read_input_tokens);
        const write = int(usage.cache_creation_input_tokens);
        const write1h = int(usage.cache_creation?.ephemeral_1h_input_tokens);
        const output = int(usage.output_tokens);
        const row: Request = { agent: lane, t, model: named || model, effort: effort || undefined, input: fresh + cached + write, cached, cacheWrite: write,
          output, reasoning: int(usage.output_tokens_details?.thinking_tokens), cost: claudeCost(named || model, claudeUnits(fresh, cached, write - write1h, write1h, output)),
          stop: string(message.stop_reason) || undefined, thinkingMs: int(record.thinkingDurationMs) || undefined };
        // Each content block of one reply repeats the reply's usage; a later block can carry the final output count.
        if (index === undefined) {
          if (row.input || row.output) { index = session.requests.push(row) - 1; requests.set(id, index); }
          UNITS.set(row, claudeUnits(fresh, cached, write - write1h, write1h, output));
        } else {
          const kept = session.requests[index];
          kept.output = Math.max(kept.output, output);
          kept.reasoning = Math.max(kept.reasoning, row.reasoning);
          kept.stop = row.stop || kept.stop;
          kept.cost = row.cost;
          UNITS.set(kept, claudeUnits(fresh, cached, write - write1h, write1h, kept.output));
          if (row.thinkingMs) kept.thinkingMs = (kept.thinkingMs || 0) + row.thinkingMs;
        }
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === "text" && index !== undefined) said(session.requests[index], string(block.text));
        if (block?.type !== "tool_use") continue;
        calls.set(string(block.id), session.tools.push({ id: string(block.id), agent: lane, t, request: index ?? -1, name: string(block.name) || "tool",
          args: clipArgs(block.input), result: "", size: 0, error: false, dur: null }) - 1);
      }
      continue;
    }
    if (record.type !== "user" || record.isMeta) continue;
    const content = message.content;
    const results = Array.isArray(content) ? content.filter((block) => block?.type === "tool_result") : [];
    for (const block of results) {
      const index = calls.get(string(block.tool_use_id));
      if (index === undefined) continue;
      const tool = session.tools[index];
      const text = contentText(block.content) || json(block.content);
      tool.result = clip(text, RESULT);
      tool.size = text.length;
      tool.error = block.is_error === true;
      tool.dur = t && tool.t ? Math.max(0, t - tool.t) : null;
    }
    if (results.length || record.isCompactSummary) continue;
    const text = contentText(content).trim();
    if (text && !NOISE.test(text)) session.messages.push({ agent: lane, t, text: clip(text, MESSAGE) });
  }
  return { cost, first, last, model, rates };
}

// Claude Code before subagent files wrote a subagent's turns into the main transcript, marked isSidechain.
function sidechain(session: Session) {
  let index = session.agents.findIndex((agent) => agent.label === "Subagents (inline)");
  if (index < 0) index = session.agents.push({ label: "Subagents (inline)", start: 0, end: 0 }) - 1;
  return index;
}

async function desktopSessions(home: string) {
  const root = join(home, "Library", "Application Support", "Claude", "claude-code-sessions");
  const found: JSONObject[] = [];
  for (const account of await list(root)) {
    for (const group of await list(join(root, account))) {
      for (const name of await list(join(root, account, group))) {
        if (!/^local_[\w-]+\.json$/.test(name)) continue;
        try { found.push(JSON.parse(await readFile(join(root, account, group, name), "utf8"))); } catch { /* Skip a file being written. */ }
      }
    }
  }
  return found;
}

async function loadClaude(id: string, config: string, home: string): Promise<Session | null> {
  let desktop: JSONObject | undefined;
  if (id.startsWith("local_")) {
    desktop = (await desktopSessions(home)).find((session) => session.sessionId === id);
    id = string(desktop?.cliSessionId);
    if (!id) return null;
  }
  if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
  const projects = join(config, "projects");
  let path = "";
  for (const folder of await list(projects)) {
    if (await exists(join(projects, folder, `${id}.jsonl`))) { path = join(projects, folder, `${id}.jsonl`); break; }
  }
  if (!path) return null;
  desktop ||= (await desktopSessions(home)).find((session) => session.cliSessionId === id);
  const session: Session = { key: `claude:${id}`, provider: "Claude", title: string(desktop?.title), cwd: "", branch: "", path, start: 0, end: 0,
    url: desktop ? `claude://claude.ai/epitaxy/${desktop.sessionId}` : `claude://resume?session=${id}`,
    cost: null, costExact: false, agents: [{ label: "Main", start: 0, end: 0 }], requests: [], tools: [], messages: [], marks: [] };
  const calls = new Map<string, number>();
  const main = readClaude(lines(await readFile(path, "utf8")), 0, session, calls, string(desktop?.effort));
  Object.assign(session.agents[0], { start: main.first, end: main.last, model: main.model });
  const folder = join(path.slice(0, -".jsonl".length), "subagents");
  const files = (await list(folder)).filter((name) => /^agent-[\w-]+\.jsonl$/.test(name));
  const children = await Promise.all(files.map(async (name) => {
    const meta = await readFile(join(folder, name.replace(/\.jsonl$/, ".meta.json")), "utf8").then(JSON.parse).catch(() => ({}));
    return { name, meta, records: lines(await readFile(join(folder, name), "utf8").catch(() => "")) };
  }));
  children.sort((a, b) => time(a.records[0]?.timestamp) - time(b.records[0]?.timestamp));
  for (const { name, meta, records } of children) {
    const agent = session.agents.push({ label: string(meta.description) || string(meta.agentType) || name.slice(6, 14), type: string(meta.agentType) || undefined,
      description: string(meta.description) || undefined, start: 0, end: 0 }) - 1;
    const read = readClaude(records, agent, session, calls);
    Object.assign(session.agents[agent], { start: read.first, end: read.last, model: read.model || undefined });
    // The subagent's metadata names the Agent tool call that started it.
    const spawn = calls.get(string(meta.toolUseId));
    if (spawn !== undefined) session.tools[spawn].spawns = agent;
  }
  // Claude Code's own per-model totals price every request, the subagents' included, when the session has them.
  if (main.rates.size) {
    for (const request of session.requests) {
      const rate = main.rates.get(request.model);
      if (rate !== undefined) request.cost = rate * (UNITS.get(request) ?? 0);
    }
  }
  session.cost = main.cost;
  session.costExact = main.cost !== null;
  finish(session);
  return session;
}

// ---------- Codex ----------

const CODEX_CALLS = new Set(["function_call", "custom_tool_call", "web_search_call", "tool_search_call", "image_generation_call", "local_shell_call"]);
const CODEX_OUTPUTS = new Set(["function_call_output", "custom_tool_call_output", "tool_search_output", "local_shell_call_output"]);
const outputText = (output: unknown): string => typeof output === "string" ? output
  : Array.isArray(output) ? output.map((part) => string(part?.text) || (part?.type === "input_image" ? "[image]" : "")).filter(Boolean).join("\n")
  : output && typeof output === "object" ? string((output as JSONObject).content) || json(output) : "";
const exitCode = (text: string) => Number(/(?:^|\n)(?:Exit code|Process exited with code):?\s*(-?\d+)/.exec(text)?.[1] ?? /"exit_code":\s*(-?\d+)/.exec(text.slice(0, 2000))?.[1] ?? 0);

function readCodex(records: JSONObject[], agent: number, session: Session) {
  const calls = new Map<string, number>();
  let lastCall = "";
  const pending: number[] = [];
  const typed: Message[] = [];
  const items: Message[] = [];
  let model = "";
  let effort = "";
  let window = 0;
  let total = -1;
  let first = 0;
  let last = 0;
  let title = "";
  let narration = "";
  const compact = (t: number) => {
    const prior = session.marks.findLast((mark) => mark.agent === agent && mark.kind === "compact");
    if (!prior || Math.abs(prior.t - t) > 120_000) session.marks.push({ agent, t, kind: "compact", label: "Compacted" });
  };
  for (const record of records) {
    const t = time(record.timestamp);
    if (t) { first ||= t; last = Math.max(last, t); }
    const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
    if (record.type === "session_meta" && agent === 0) {
      session.cwd ||= string(payload.cwd);
      session.branch ||= string(payload.git?.branch);
    }
    if (record.type === "turn_context") {
      const named = string(payload.model);
      const level = string(payload.effort || payload.collaboration_mode?.settings?.reasoning_effort);
      if (named && named !== model) { if (model) session.marks.push({ agent, t, kind: "model", label: named }); model = named; }
      if (level && level !== effort) { if (effort) session.marks.push({ agent, t, kind: "effort", label: level }); effort = level; }
      continue;
    }
    if (record.type === "compacted") { compact(t); continue; }
    if (record.type === "event_msg") {
      const type = payload.type;
      if (type === "context_compacted") compact(t);
      else if (type === "user_message") {
        const text = string(payload.message).trim();
        if (text) typed.push({ agent, t, text: clip(text, MESSAGE) });
      } else if (type === "item_completed") {
        const item = payload.item || {};
        if (item.type === "UserMessage") {
          const text = contentText((item.content || []).map((part: JSONObject) => ({ type: part.type === "text" ? "text" : part.type, text: part.text }))).trim();
          if (text) items.push({ agent, t, text: clip(text, MESSAGE) });
        } else if (item.type === "ContextCompaction") compact(t);
        else if ((item.type === "CommandExecution" || item.type === "McpToolCall") && lastCall === "exec") {
          // Code mode runs shell commands and MCP tools inside one `exec` call; each is its own item with a real status.
          const command = Array.isArray(item.command) ? item.command.at(-1) : item.command;
          const result = item.type === "CommandExecution" ? string(item.aggregated_output) : outputText(item.result?.content ?? item.result);
          const started = int(payload.started_at_ms) || t;
          pending.push(session.tools.push({ id: string(item.id) || `exec:${agent}:${started}:${session.tools.length}`, agent, t: started, request: -1, via: "exec",
            name: item.type === "CommandExecution" ? "shell" : `${string(item.server)}.${string(item.tool)}`,
            args: item.type === "CommandExecution" ? clip(string(command), ARGS) : clipArgs(item.arguments), result: clip(result, RESULT), size: result.length,
            error: item.status === "failed" || item.result?.isError === true || (item.exit_code ?? 0) !== 0,
            dur: int(payload.completed_at_ms) ? int(payload.completed_at_ms) - started : null }) - 1);
        }
      } else if (type === "token_count") {
        const info = payload.info || {};
        const usage = info.last_token_usage;
        window = int(info.model_context_window) || window;
        const seen = int(info.total_token_usage?.total_tokens);
        // Codex repeats a token_count when only rate limits change; the running total says whether it is new.
        if (!usage || seen === total) continue;
        total = seen;
        const input = int(usage.input_tokens);
        const cached = int(usage.cached_input_tokens);
        const output = int(usage.output_tokens);
        const index = session.requests.push({ agent, t, model: model || "?", effort: effort || undefined, input, cached, cacheWrite: int(usage.cache_write_input_tokens),
          output, reasoning: int(usage.reasoning_output_tokens), cost: codexCost(model, input, cached, output), window: window || undefined }) - 1;
        for (const tool of pending.splice(0)) session.tools[tool].request = index;
        if (narration) { said(session.requests[index], narration); narration = ""; }
      } else if (type?.endsWith?.("_end") && calls.has(string(payload.call_id))) {
        const tool = session.tools[calls.get(string(payload.call_id))!];
        const duration = payload.duration;
        if (duration && typeof duration === "object") tool.dur = int(duration.secs) * 1000 + Math.round(int(duration.nanos) / 1e6);
        if (int(payload.exit_code) !== 0 || payload.success === false) tool.error = true;
      } else if (type === "thread_name_updated" && agent === 0) title = string(payload.thread_name) || title;
      continue;
    }
    if (record.type !== "response_item") continue;
    if (payload.type === "message" && payload.role === "assistant") {
      narration = [narration, outputText(payload.content)].filter(Boolean).join("\n\n");
    } else if (CODEX_CALLS.has(payload.type)) {
      const id = string(payload.call_id) || `${payload.type}:${t}:${calls.size}`;
      const name = payload.type === "function_call" || payload.type === "custom_tool_call"
        ? [string(payload.namespace).replace(/^mcp__/, "").replace(/__$/, ""), string(payload.name)].filter(Boolean).join(".")
        : payload.type.replace(/_call$/, "");
      const index = session.tools.push({ id, agent, t, request: -1, name: name || "tool", args: clipArgs(payload.arguments ?? payload.input ?? payload.action ?? ""), result: "", size: 0,
        error: payload.status === "failed", dur: null }) - 1;
      calls.set(id, index);
      pending.push(index);
      lastCall = name;
    } else if (CODEX_OUTPUTS.has(payload.type)) {
      const index = calls.get(string(payload.call_id));
      if (index === undefined) continue;
      const tool = session.tools[index];
      const text = outputText(payload.output);
      tool.result = clip(text, RESULT);
      tool.size = text.length;
      tool.dur ??= t && tool.t ? Math.max(0, t - tool.t) : null;
      if (payload.status === "failed" || exitCode(text) !== 0 || /^(?:Script (?:failed|error)|Error:|error:)/.test(text)) tool.error = true;
    }
  }
  // A closing answer can follow the thread's last token count.
  const lastOwn = session.requests.findLast((request) => request.agent === agent);
  if (narration && lastOwn) said(lastOwn, narration);
  // Older rollouts log typed input as user_message events; newer ones only as completed UserMessage items.
  session.messages.push(...(typed.length ? typed : items));
  return { first, last, model, title };
}

async function findRollout(home: string, id: string) {
  const sessions = join(home, "sessions");
  for (const year of (await list(sessions)).sort().reverse()) {
    for (const month of (await list(join(sessions, year))).sort().reverse()) {
      for (const day of (await list(join(sessions, year, month))).sort().reverse()) {
        const name = (await list(join(sessions, year, month, day))).find((file) => file.includes(`${id}.jsonl`));
        if (name) return join(sessions, year, month, day, name);
      }
    }
  }
  const archived = (await list(join(home, "archived_sessions"))).find((file) => file.includes(`${id}.jsonl`));
  return archived ? join(home, "archived_sessions", archived) : "";
}

async function loadCodex(id: string, home: string): Promise<Session | null> {
  if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
  const query = await codexQuery(home).catch(() => null);
  const rows = async (sql: string) => query ? JSON.parse((await query(sql).catch(() => ({ stdout: "[]" }))).stdout || "[]") as JSONObject[] : [];
  const [row] = await rows(`SELECT * FROM threads WHERE id = '${id}'`);
  const path = row?.rollout_path && await exists(row.rollout_path) ? string(row.rollout_path) : await findRollout(home, id);
  if (!path) return null;
  const session: Session = { key: `codex:${id}`, provider: "Codex", title: clip(string(row?.name || row?.title).split("\n")[0], 200), cwd: string(row?.cwd), branch: "", path, start: 0, end: 0,
    url: `codex://threads/${id}`, cost: null, costExact: false, agents: [{ label: "Main", start: 0, end: 0 }], requests: [], tools: [], messages: [], marks: [] };
  const main = readCodex(lines(await readLog(path)), 0, session);
  Object.assign(session.agents[0], { start: main.first, end: main.last, model: main.model });
  session.title ||= main.title;
  // Subagents, and their own subagents, are threads whose source names this thread as the parent.
  const queue = [id];
  for (let depth = 0; queue.length && depth < 4; depth++) {
    const parents = queue.splice(0);
    const kids = await rows(`SELECT id, rollout_path AS path, agent_nickname AS nickname, agent_role AS role, title, source FROM threads
      WHERE ${parents.map((parent) => `source LIKE '%"parent_thread_id":"${parent}"%'`).join(" OR ")} ORDER BY created_at`);
    for (const kid of kids) {
      if (!await exists(kid.path)) continue;
      const spawn = (() => { try { return JSON.parse(kid.source).subagent?.thread_spawn || {}; } catch { return {}; } })();
      const task = string(spawn.agent_path);
      const role = string(kid.role) || task.split("/").filter(Boolean).at(-1) || "";
      const agent = session.agents.push({ label: [kid.nickname, role.replaceAll("_", " ")].filter(Boolean).join(" · ") || string(kid.title).slice(0, 60) || "Subagent",
        type: role || undefined, description: string(kid.title).split("\n")[0] || undefined, start: 0, end: 0 }) - 1;
      const read = readCodex(lines(await readLog(kid.path)), agent, session);
      Object.assign(session.agents[agent], { start: read.first, end: read.last, model: read.model || undefined });
      // The spawn_agent call whose result names the child's task path (or thread ID) started it.
      const call = session.tools.find((tool) => tool.spawns === undefined && /spawn/.test(tool.name)
        && (tool.result.includes(kid.id) || (task && tool.result.includes(`"task_name":"${task}"`))));
      if (call) call.spawns = agent;
      queue.push(kid.id);
    }
  }
  const costs = session.requests.map((request) => request.cost);
  session.cost = costs.length && costs.every((cost) => cost !== null) ? costs.reduce((sum, cost) => sum! + cost!, 0) : null;
  finish(session);
  return session;
}

function finish(session: Session) {
  const unsorted = session.requests.slice();
  for (const list of [session.requests, session.tools, session.messages, session.marks] as { t: number }[][]) list.sort((a, b) => a.t - b.t);
  const position = new Map(session.requests.map((request, index) => [request, index]));
  for (const tool of session.tools) {
    if (tool.request >= 0) { tool.request = position.get(unsorted[tool.request])!; continue; }
    // A call logged with no request of its own belongs to the agent's nearest request in time.
    const own = session.requests.map((request, index) => ({ request, index })).filter(({ request }) => request.agent === tool.agent);
    tool.request = (own.find(({ request }) => request.t >= tool.t) || own.at(-1))?.index ?? -1;
  }
  const times = [...session.agents.flatMap((agent) => [agent.start, agent.end])].filter(Boolean);
  session.start = Math.min(...times);
  session.end = Math.max(...times);
  if (session.cost === null) {
    const costs = session.requests.map((request) => request.cost).filter((cost): cost is number => cost !== null);
    session.cost = costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null;
  }
  session.title ||= session.messages.find((message) => message.agent === 0)?.text.split("\n")[0].slice(0, 160) || basename(session.cwd) || "Session";
}

// Reads a session by key ("claude:<session id>", "claude:local_<desktop id>" or "codex:<thread id>"), caching by file size.
export function createSessionReader({ home = homedir(), codexHome = process.env.CODEX_HOME || join(home, ".codex"),
  claudeConfig = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude") } = {}) {
  const cache = new Map<string, { stamp: string; session: Session }>();
  return async (key: string) => {
    const [provider, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    const hit = cache.get(key);
    if (hit && hit.stamp === await stamp(hit.session)) return hit.session;
    const session = provider === "claude" ? await loadClaude(id, claudeConfig, home) : provider === "codex" ? await loadCodex(id, codexHome) : null;
    if (session) {
      cache.set(key, { stamp: await stamp(session), session });
      if (cache.size > 12) cache.delete(cache.keys().next().value!);
    }
    return session;
  };
}

// A session changes when its log grows; a Claude subagent writes its own file, so its folder counts too.
async function stamp(session: Session) {
  const files = [session.path];
  if (session.provider === "Claude") {
    const folder = join(session.path.slice(0, -".jsonl".length), "subagents");
    files.push(...(await list(folder)).filter((name) => name.endsWith(".jsonl")).map((name) => join(folder, name)));
  }
  const sizes = await Promise.all(files.map((file) => stat(file).then((info) => info.size, () => 0)));
  return sizes.join(",");
}
