// Problems and waste in one agent chat session, worst first, for the session overlay's Findings tab. Each finding names
// the calls and requests it comes from, so the overlay can list them and light them up on the chart. Token figures are
// estimates: a result's characters / 4, and a result's tokens again for each later request that still carried it.
// Pure over the /api/chat-session payload, so the tests run it under Node.

const CHARS_PER_TOKEN = 4;
const BIG_RESULT = 20_000; // characters, about 5k tokens
const SLOW_CALL = 60_000;
const CACHE_TTL = 5 * 60_000;
const READS = new Set(["Read", "NotebookRead", "view_image"]);
const CHANGES = new Set(["Edit", "MultiEdit", "NotebookEdit", "Write", "apply_patch"]);
const SEVERITY = { problem: 0, waste: 1, info: 2 };
const changed = (tool) => CHANGES.has(tool.name) && !tool.error;

export function parseArgs(tool) {
  try { const value = JSON.parse(tool.args); return value && typeof value === "object" ? value : null; } catch { return null; }
}

// Paths a tool call read or changed: Claude's file_path/path/notebook_path, Codex's apply_patch headers.
export function toolFiles(tool) {
  const args = parseArgs(tool);
  const patch = typeof args?.input === "string" ? args.input : typeof args?.patch === "string" ? args.patch : args ? "" : tool.args;
  if (patch.includes("*** Begin Patch")) return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1].trim());
  const path = args && (args.file_path || args.notebook_path || (/^(?:Grep|Glob|LS)$/.test(tool.name) ? "" : args.path));
  return typeof path === "string" && path ? [path] : [];
}

// The shell command of a call, for Claude's Bash and Codex's exec_command, shell and code-mode commands.
export function command(tool) {
  const args = parseArgs(tool);
  if (!args) return /^(?:shell|local_shell)$/.test(tool.name) ? tool.args : "";
  const value = args.command ?? args.cmd;
  return Array.isArray(value) ? value.join(" ") : typeof value === "string" ? value : "";
}

const tokens = (chars) => Math.round(chars / CHARS_PER_TOKEN);
const base = (path) => path.split("/").filter(Boolean).at(-1) || path;
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function findings(data) {
  const found = [];
  const tools = data.tools.map((tool, index) => ({ ...tool, index }));
  const byAgent = Map.groupBy(tools, (tool) => tool.agent);
  const compactions = data.marks.filter((mark) => mark.kind === "compact");

  // Failed calls, by tool. A failure run again before anything changed is a blind retry.
  const same = (a, b) => a.name === b.name && (command(a) || a.args) === (command(b) || b.args);
  for (const [agent, calls] of byAgent) {
    for (const [name, failed] of Map.groupBy(calls.filter((tool) => tool.error), (tool) => tool.name)) {
      const retried = failed.filter((tool) => {
        const later = calls.filter((other) => other.t > tool.t);
        const next = later.findIndex((other) => same(other, tool));
        return next >= 0 && !later.slice(0, next).some((other) => changed(other));
      }).length;
      found.push({ kind: "failed", severity: "problem", agent, title: `${name} failed ${plural(failed.length, "time")}`,
        detail: `${retried ? `${retried} ${retried === 1 ? "was" : "were"} run again with nothing changed in between. ` : ""}${firstLine(failed[0].result) || "No result logged."}`,
        calls: failed.map((tool) => tool.index), tokens: tokens(failed.reduce((sum, tool) => sum + tool.size, 0)) });
    }
  }

  // The same call three or more times in a row with no change in between: polling, or an agent stuck on one step.
  for (const [agent, calls] of byAgent) {
    const runs = [];
    let open = new Map();
    for (const tool of calls) {
      if (changed(tool)) { runs.push(...open.values()); open = new Map(); continue; }
      if (READS.has(tool.name)) continue;
      const key = `${tool.name}\n${command(tool) || tool.args}`;
      open.set(key, [...(open.get(key) || []), tool]);
    }
    runs.push(...open.values());
    for (const same of runs) {
      if (same.length < 3) continue;
      const label = command(same[0]) || summary(same[0]);
      const waited = same.reduce((sum, tool) => sum + (tool.dur || 0), 0);
      found.push({ kind: "repeat", severity: "problem", agent, title: `Ran the same ${same[0].name} call ${same.length} times`,
        detail: `${label.slice(0, 160)}${waited ? ` · ${seconds(waited)} spent` : ""}`, calls: same.map((tool) => tool.index),
        tokens: tokens(same.slice(1).reduce((sum, tool) => sum + tool.size, 0)) });
    }
  }

  // A file read again with no change to it in between, by the same agent, or by a subagent after the main agent read it.
  for (const [agent, calls] of byAgent) {
    const seen = new Map();
    const again = new Map();
    for (const tool of calls) {
      for (const path of toolFiles(tool)) {
        if (changed(tool)) { seen.delete(path); continue; }
        if (!READS.has(tool.name)) continue;
        if (seen.has(path)) again.set(path, [...(again.get(path) || [seen.get(path)]), tool]);
        else seen.set(path, tool);
      }
    }
    const repeats = [...again].flatMap(([, reads]) => reads.slice(1));
    if (!repeats.length) continue;
    const files = [...again.keys()];
    found.push({ kind: "reread", severity: "waste", agent, title: `Read ${plural(files.length, "file")} again with no change in between`,
      detail: files.map((path) => `${base(path)} ×${again.get(path).length}`).join(", "),
      calls: [...again.values()].flat().map((tool) => tool.index), tokens: tokens(repeats.reduce((sum, tool) => sum + tool.size, 0)) });
  }
  for (const [agent, calls] of byAgent) {
    if (!agent) continue;
    const spawn = tools.find((tool) => tool.spawns === agent);
    const before = (byAgent.get(spawn?.agent ?? 0) || []).filter((tool) => READS.has(tool.name) && tool.t <= (spawn?.t ?? data.agents[agent].start));
    const known = new Set(before.flatMap(toolFiles));
    const dup = calls.filter((tool) => READS.has(tool.name) && toolFiles(tool).some((path) => known.has(path)));
    if (!dup.length) continue;
    found.push({ kind: "handoff", severity: "waste", agent, title: `Subagent re-read ${plural(new Set(dup.flatMap(toolFiles)).size, "file")} its parent already had`,
      detail: `${[...new Set(dup.flatMap(toolFiles))].map(base).join(", ")}. Passing what the parent learned in the prompt would skip these reads.`,
      calls: dup.map((tool) => tool.index), tokens: tokens(dup.reduce((sum, tool) => sum + tool.size, 0)) });
  }

  // Large results stay in the context for every later request until a compaction.
  for (const [agent, calls] of byAgent) {
    const big = calls.filter((tool) => tool.size >= BIG_RESULT).map((tool) => {
      const until = compactions.find((mark) => mark.agent === agent && mark.t > tool.t)?.t ?? Infinity;
      return { tool, carried: data.requests.filter((request) => request.agent === agent && request.t > tool.t && request.t < until).length };
    });
    if (!big.length) continue;
    const top = big.toSorted((a, b) => b.tool.size - a.tool.size)[0];
    found.push({ kind: "big", severity: "waste", agent, title: big.length === 1 ? `${top.tool.name} returned ${tokens(top.tool.size).toLocaleString()} tokens` : `${big.length} results over ${tokens(BIG_RESULT) / 1000}k tokens each`,
      detail: `${big.length > 1 ? "Largest: " : ""}${summary(top.tool).slice(0, 120)}, ${tokens(top.tool.size).toLocaleString()} tokens carried through ${plural(top.carried, "later request")}.`,
      calls: big.map(({ tool }) => tool.index), tokens: big.reduce((sum, { tool, carried }) => sum + tokens(tool.size) * Math.max(1, carried), 0) });
  }

  // A request that paid for most of its prompt again: the cache expired (an idle gap) or the prompt changed near the top.
  for (const [agent, requests] of Map.groupBy(data.requests.map((request, index) => ({ request, index })), ({ request }) => request.agent)) {
    const misses = requests.filter(({ request }, at) => {
      const prior = requests[at - 1]?.request;
      const uncached = request.input - request.cached;
      if (!prior || uncached < 20_000 || uncached < request.input / 2) return false;
      return !compactions.some((mark) => mark.agent === agent && mark.t > prior.t && mark.t <= request.t);
    }).map(({ request, index }) => ({ request, index, gap: request.t - requests[requests.findIndex((item) => item.index === index) - 1].request.t }));
    if (!misses.length) continue;
    const sent = misses.reduce((sum, { request }) => sum + request.input - request.cached, 0);
    const idle = misses.filter(({ gap }) => gap > CACHE_TTL);
    const costs = misses.map(({ request }) => request.cost).filter((cost) => cost !== null && cost !== undefined);
    found.push({ kind: "cache", severity: "waste", agent, title: misses.length === 1 ? `Cache miss: ${Math.round(sent / 1000)}k tokens sent again` : `${misses.length} cache misses: ${Math.round(sent / 1000)}k tokens sent again`,
      detail: idle.length ? `${idle.length === misses.length ? (misses.length === 1 ? "It came" : "All came") : `${idle.length} came`} after an idle gap (longest ${seconds(Math.max(...idle.map(({ gap }) => gap)))}), longer than the cache keeps a prompt.` : "The prompt changed near its start, so the cache could not be used.",
      calls: [], requests: misses.map(({ index }) => index), tokens: sent, cost: costs.length ? costs.reduce((a, b) => a + b, 0) : undefined });
  }

  // Long tool calls hold the agent; a long wait is worth a faster command or running it in the background.
  const slow = tools.filter((tool) => (tool.dur || 0) >= SLOW_CALL && tool.spawns === undefined && !/^(?:Agent|Task|wait|wait_agent)$/.test(tool.name));
  if (slow.length) {
    found.push({ kind: "slow", severity: "info", agent: slow[0].agent, agents: [...new Set(slow.map((tool) => tool.agent))],
      title: `${plural(slow.length, "call")} took over a minute`, detail: slowest(slow),
      calls: slow.map((tool) => tool.index), tokens: 0, ms: slow.reduce((sum, tool) => sum + tool.dur, 0) });
  }

  // Near the context window, a session is about to compact.
  for (const request of data.requests) {
    if (!request.window || request.input < request.window * 0.85) continue;
    found.push({ kind: "window", severity: "info", agent: request.agent, title: `Context reached ${Math.round(100 * request.input / request.window)}% of the window`,
      detail: "Compaction drops detail. Subagents or a fresh session keep the main context smaller.", calls: [], requests: [data.requests.indexOf(request)], tokens: 0 });
    break;
  }

  for (const finding of found) {
    finding.requests ??= [...new Set(finding.calls.map((index) => data.tools[index].request).filter((index) => index >= 0))];
    finding.id = `${finding.kind}:${finding.agent}:${finding.calls[0] ?? finding.requests[0] ?? 0}`;
  }
  return found.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || b.tokens - a.tokens || (b.ms || 0) - (a.ms || 0));
}

const firstLine = (text) => String(text || "").replace(/<\/?[\w-]+>/g, "").split("\n").map((line) => line.trim()).find((line) => line && !/^(?:Exit code|Wall time|Output):?/.test(line)) || "";
// A call in a few words: its files, its command without the leading `cd`, or its pattern, title or description.
// Arguments with none of those fall back to the tool's name, never raw JSON.
function summary(tool) {
  const files = toolFiles(tool);
  if (files.length) return files.map(base).join(", ");
  const shell = command(tool);
  if (shell) return shell.replace(/^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/, "").replace(/\s+/g, " ");
  const args = parseArgs(tool);
  if (!args) return String(tool.args).replace(/\s+/g, " ");
  const value = [args.pattern, args.query, args.title, args.description, args.url, args.prompt, args.message].find((item) => typeof item === "string" && item.trim());
  return (value ?? (tool.name.startsWith("mcp__") ? tool.name.split("__").slice(2).join("__") : tool.name)).replace(/\s+/g, " ");
}
// The slowest calls first, three of them, then how many more.
function slowest(slow) {
  const top = [...slow].sort((a, b) => b.dur - a.dur);
  return `${top.slice(0, 3).map((tool) => `${summary(tool).slice(0, 56)} (${seconds(tool.dur)})`).join(" · ")}${top.length > 3 ? `, and ${top.length - 3} more` : ""}`;
}
function seconds(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${String(Math.round(ms % 60_000 / 1000)).padStart(2, "0")}s`;
  return `${Math.floor(ms / 3_600_000)}h ${String(Math.round(ms % 3_600_000 / 60_000)).padStart(2, "0")}m`;
}

// The findings as Markdown for the Review with an agent prompt.
export function findingsMarkdown(list, data) {
  if (!list.length) return "";
  const who = (agent) => agent ? ` (subagent: ${data.agents[agent].label})` : "";
  return `Problems the overlay found, worst first:\n\n${list.map((finding) => `- **${finding.title}**${who(finding.agent)}: ${finding.detail}${finding.tokens ? ` About ${finding.tokens.toLocaleString()} tokens.` : ""}`).join("\n")}`;
}
