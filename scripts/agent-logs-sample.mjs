// Writes fictional Claude Code and Codex session logs to examples/agent-logs/, for the session overlay's screenshots,
// tests and demo. Both are the acme team's work from examples/workspace; nothing here comes from a real transcript.
//
//   node scripts/agent-logs-sample.mjs
//
// Point the server at them with CLAUDE_CONFIG_DIR=examples/agent-logs/claude CODEX_HOME=examples/agent-logs/codex.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_SESSION = "5e55a0c1-0103-4a11-9c3e-ac0e00000101";
export const CODEX_SESSION = "019a0101-c01d-7a57-a7e5-ac0e00000103";
const root = fileURLToPath(new URL("../examples/agent-logs", import.meta.url));
const start = Date.parse("2026-10-21T14:02:00Z");

let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const between = (low, high) => Math.round(low + random() * (high - low));
const stamp = (ms) => new Date(ms).toISOString();

// ---------- Claude Code: TASK-0101, workspace invites, with two subagents and one compaction ----------

function claudeLog(cwd, sessionId, steps, { sidechain = false, effort = "medium" } = {}) {
  const records = [];
  let t = steps.start;
  let context = steps.context;
  let request = 0;
  let level = effort;
  let call = 0;
  const base = { cwd, sessionId, version: "2.1.300", gitBranch: "invites/accept-flow", userType: "external", entrypoint: "claude-desktop", isSidechain: sidechain };
  for (const step of steps.list) {
    if (step.user) {
      t += between(20, 90) * 1000;
      records.push({ ...base, type: "user", timestamp: stamp(t), message: { role: "user", content: step.user } });
      if (step.effort) level = step.effort;
      continue;
    }
    if (step.compact) {
      t += 40_000;
      records.push({ ...base, type: "system", subtype: "compact_boundary", content: "Conversation compacted", timestamp: stamp(t),
        compactMetadata: { trigger: "auto", preTokens: context, postTokens: step.compact } });
      context = step.compact;
      records.push({ ...base, type: "user", isCompactSummary: true, timestamp: stamp(t + 10), message: { role: "user", content: "This session is being continued from a previous conversation…" } });
      continue;
    }
    t += between(4, 14) * 1000;
    const grown = between(900, 5200) + (step.tools || []).reduce((sum, tool) => sum + (tool.size || 1200) / 3.4, 0);
    const write = Math.round(grown);
    const output = between(120, 900) + (step.text ? 400 : 0);
    const thinking = Math.round(output * (0.2 + random() * 0.3));
    const id = `req_${sessionId.slice(0, 4)}${String(++request).padStart(4, "0")}`;
    const usage = { input_tokens: between(1, 6), cache_read_input_tokens: context, cache_creation_input_tokens: write, output_tokens: output,
      output_tokens_details: { thinking_tokens: thinking }, cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 } };
    const content = [];
    if (step.text) content.push({ type: "text", text: step.text });
    const uses = (step.tools || []).map((tool) => ({ ...tool, id: `toolu_${sessionId.slice(0, 4)}${String(++call).padStart(5, "0")}` }));
    for (const tool of uses) content.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input });
    records.push({ ...base, type: "assistant", timestamp: stamp(t), requestId: id, effort: level, perTurnEffort: level, thinkingDurationMs: between(400, 4000),
      message: { model: step.model || "claude-opus-5-5", id: `msg_${id}`, role: "assistant", content, stop_reason: uses.length ? "tool_use" : "end_turn", usage } });
    context += write;
    for (const tool of uses) {
      t += tool.ms ?? between(300, 4000);
      const text = tool.result || `${"ok\n".repeat(Math.round((tool.size || 1200) / 30))}`;
      records.push({ ...base, type: "user", timestamp: stamp(t), message: { role: "user",
        content: [{ type: "tool_result", tool_use_id: tool.id, content: text, ...(tool.error ? { is_error: true } : {}) }] } });
      tool.onResult?.(tool.id);
    }
  }
  return { records, end: t };
}

const read = (path, size = 2600) => ({ name: "Read", input: { file_path: `/Users/dev/acme/orbit-invites/${path}` }, size, ms: between(20, 90),
  result: source(path, Math.round(size / 40)) });
// Numbered lines in the shape Claude Code's Read returns, from a short fictional module.
const SOURCE = ['import { db } from "../db";', 'import { WEEK } from "../time";', "", "export type Invite = {", "  id: string;", "  workspaceId: string;",
  '  role: "viewer" | "editor" | "admin";', "  token: string;", "  expiresAt: number;", "  acceptedAt?: number;", "};", "",
  "export async function findInvite(token: string) {", '  return db.one<Invite>("SELECT * FROM invites WHERE token = $1", [token]);', "}"];
function source(path, count) {
  return Array.from({ length: count }, (_, index) => `${String(index + 1).padStart(6)}\t${index === 0 ? `// ${path}` : SOURCE[(index - 1) % SOURCE.length]}`).join("\n");
}
const grep = (pattern, size = 900) => ({ name: "Grep", input: { pattern, path: "/Users/dev/acme/orbit-invites/src" }, size, ms: between(60, 300),
  result: `src/invites/accept.ts:14: ${pattern}\nsrc/invites/send.ts:40: ${pattern}\nsrc/api/routes.ts:88: ${pattern}` });
const edit = (path) => ({ name: "Edit", input: { file_path: `/Users/dev/acme/orbit-invites/${path}`, old_string: "const expires = 0;", new_string: "const expires = Date.now() + WEEK;" },
  size: 120, ms: between(30, 120), result: `The file /Users/dev/acme/orbit-invites/${path} has been updated successfully.` });
const write = (path, size = 3000) => ({ name: "Write", input: { file_path: `/Users/dev/acme/orbit-invites/${path}`, content: "export function acceptInvite(token: string) {\n  …\n}\n" },
  size: 140, ms: between(30, 120), result: `File created successfully at: /Users/dev/acme/orbit-invites/${path}` });
const bash = (command, result, { error = false, ms = between(800, 9000), description = "" } = {}) => ({ name: "Bash", input: { command, description }, size: result.length, ms, error, result });

function subagent(folder, agentId, toolUseId, meta, at, list) {
  const log = claudeLog("/Users/dev/acme/orbit-invites", CLAUDE_SESSION, { start: at, context: 14_200, list }, { sidechain: true });
  return { path: join(folder, `agent-${agentId}.jsonl`), meta: join(folder, `agent-${agentId}.meta.json`), records: log.records, end: log.end,
    metaJson: { agentType: meta.type, description: meta.description, toolUseId, model: meta.model || "inherit", finished: true } };
}

async function claude() {
  const folder = join(root, "claude", "projects", "-Users-dev-acme-orbit-invites");
  await mkdir(join(folder, CLAUDE_SESSION, "subagents"), { recursive: true });
  const children = [];
  const agentCall = (agentId, meta, prompt) => ({ name: "Agent", input: { description: meta.description, subagent_type: meta.type, prompt }, size: 1400, ms: between(140_000, 260_000),
    result: `${meta.summary}\n\nagentId: ${agentId}`, spawn: { agentId, meta } });
  const steps = [
    { user: "Build the accept flow for workspace invites (TASK-0101). An invite link should land a new member in the right workspace with the right role, expire after 7 days, and show a clear page when it has expired. Add tests for each case." },
    { text: "I'll read the invite model and the current routes first.", tools: [read("src/invites/model.ts", 3400), read("src/api/routes.ts", 5200), grep("inviteToken")] },
    { tools: [read("src/invites/send.ts", 2800), read("src/auth/session.ts", 4100)] },
    { tools: [grep("role:", 1400), read("src/workspaces/members.ts", 3600)] },
    { text: "The token has no expiry today. I'll add one and a migration.", tools: [edit("src/invites/model.ts"), write("migrations/0042_invite_expiry.sql")] },
    { tools: [write("src/invites/accept.ts", 4200)] },
    { tools: [bash("pnpm test src/invites", "FAIL src/invites/accept.test.ts\n  ● accept › joins the workspace with the invited role\n    Expected: \"editor\"\n    Received: \"viewer\"\n\nTests: 1 failed, 6 passed, 7 total", { error: true, ms: 14_200, description: "Run the invite tests" })] },
    { text: "The role comes from the workspace default, not the invite. Fixing that.", tools: [read("src/workspaces/members.ts", 3600), edit("src/invites/accept.ts")] },
    { tools: [bash("pnpm test src/invites", "PASS src/invites/accept.test.ts\nPASS src/invites/send.test.ts\n\nTests: 7 passed, 7 total", { ms: 12_800, description: "Run the invite tests" })] },
    { text: "Two parts are separable: the expired-invite page and the email copy. I'll give each to a subagent.",
      tools: [
        agentCall("a1f0c2d3e4b5a6c7", { type: "general-purpose", description: "Expired invite page", summary: "Added /invite/expired with a resend button and a test." }, "Build the expired-invite page in src/pages/invite-expired.tsx …"),
        agentCall("b2e1d3c4f5a6b7c8", { type: "Explore", description: "Find invite email templates", model: "haiku", summary: "Templates live in emails/invite.mjml and emails/invite-reminder.mjml." }, "Find every email template that mentions invites …"),
      ] },
    { tools: [read("src/pages/invite-expired.tsx", 2200), bash("pnpm typecheck", "src/pages/invite-expired.tsx(18,7): error TS2322: Type 'string | undefined' is not assignable to type 'string'.", { error: true, ms: 9_400, description: "Type-check" })] },
    { tools: [edit("src/pages/invite-expired.tsx"), bash("pnpm typecheck", "", { ms: 8_900, description: "Type-check" })] },
    { tools: [read("emails/invite.mjml", 1800), edit("emails/invite.mjml")] },
    { user: "Looks good. Can you also make sure an invite can only be used once, and think hard about the race where two tabs accept at the same time?", effort: "high" },
    { text: "I'll use a conditional update so only one accept wins.", tools: [read("src/db/index.ts", 2600), grep("UPDATE invites", 600)] },
    { tools: [edit("src/invites/accept.ts"), write("src/invites/accept-race.test.ts", 2400)] },
    { tools: [bash("pnpm test src/invites", "PASS src/invites/accept.test.ts\nPASS src/invites/accept-race.test.ts\nPASS src/invites/send.test.ts\n\nTests: 9 passed, 9 total", { ms: 15_600, description: "Run the invite tests" })] },
    { compact: 24_800 },
    { text: "Context was compacted. Running the full suite before the PR.", tools: [bash("pnpm test", "Tests: 412 passed, 412 total\nTime: 61.2 s", { ms: 63_000, description: "Run every test" })] },
    { tools: [bash("git status --short", " M src/invites/model.ts\n M src/invites/accept.ts\n?? src/invites/accept-race.test.ts\n?? migrations/0042_invite_expiry.sql", { ms: 300 })] },
    { tools: [bash("git commit -am \"Add the invite accept flow\"", "[invites/accept-flow 4c1d2e9] Add the invite accept flow\n 9 files changed, 412 insertions(+), 18 deletions(-)", { ms: 1_400 })] },
    { tools: [bash("gh pr create --fill", "https://github.com/acme/orbit/pull/231", { ms: 4_200 })] },
    { text: "Opened acme/orbit#231. The accept flow joins with the invited role, expires after 7 days, shows the expired page with a resend button, and a second accept of the same invite fails cleanly." },
  ];
  // Each Agent call writes its subagent's own transcript.
  const main = claudeLog("/Users/dev/acme/orbit-invites", CLAUDE_SESSION, { start, context: 18_400, list: steps.map((step) => ({
    ...step, tools: step.tools?.map((tool) => tool.spawn ? { ...tool, onResult: (id) => children.push({ id, ...tool.spawn }) } : tool),
  })) });
  const files = [];
  for (const [index, child] of children.entries()) {
    const at = start + 22 * 60_000 + index * 40_000;
    const list = index === 0
      ? [{ tools: [read("src/pages/invite-sent.tsx", 1800), grep("ExpiredPage", 300)] }, { tools: [write("src/pages/invite-expired.tsx", 2200)] },
        { tools: [write("src/pages/invite-expired.test.tsx", 1600), bash("pnpm test src/pages", "Tests: 3 passed, 3 total", { ms: 7_800 })] }, { text: "Added /invite/expired with a resend button and a test." }]
      : [{ model: "claude-haiku-5-5", tools: [grep("invite", 2400)] }, { model: "claude-haiku-5-5", tools: [read("emails/invite.mjml", 1800), read("emails/invite-reminder.mjml", 1700)] },
        { model: "claude-haiku-5-5", text: "Templates live in emails/invite.mjml and emails/invite-reminder.mjml." }];
    files.push(subagent(join(folder, CLAUDE_SESSION, "subagents"), child.agentId, child.id, child.meta, at, list));
  }
  main.records.unshift({ type: "custom-title", customTitle: "TASK-0101 · Ship workspace invites", sessionId: CLAUDE_SESSION });
  main.records.push({ type: "cost-state", sessionId: CLAUDE_SESSION, totalCostUSD: 4.82 });
  const jsonl = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  await writeFile(join(folder, `${CLAUDE_SESSION}.jsonl`), jsonl(main.records));
  for (const file of files) {
    await writeFile(file.path, jsonl(file.records));
    await writeFile(file.meta, JSON.stringify(file.metaJson, null, 2) + "\n");
  }
}

// ---------- Codex: TASK-0103, dashboard cold start, with a model change, an effort change and a compaction ----------

async function codex() {
  const folder = join(root, "codex", "sessions", "2026", "10", "21");
  await mkdir(folder, { recursive: true });
  const records = [];
  let t = start + 3 * 3600_000;
  let context = 21_000;
  let total = 0;
  let call = 0;
  const push = (type, payload) => records.push({ timestamp: stamp(t), type, payload });
  const cwd = "/Users/dev/acme/orbit";
  push("session_meta", { id: CODEX_SESSION, cwd, originator: "Codex Desktop", source: "vscode", model_provider: "openai", git: { branch: "perf/cold-start" } });
  let model = "gpt-6-astra";
  let effort = "high";
  const turn = () => push("turn_context", { cwd, model, effort });
  const user = (message) => { t += 30_000; turn(); push("event_msg", { type: "user_message", message }); push("event_msg", { type: "task_started" }); };
  const request = (tools = [], text = "") => {
    t += between(3, 10) * 1000;
    if (text) push("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
    for (const tool of tools) {
      const id = `call_${String(++call).padStart(4, "0")}`;
      push("response_item", { type: "function_call", name: tool.name, arguments: JSON.stringify(tool.args), call_id: id });
      t += tool.ms ?? between(400, 6000);
      push("response_item", { type: "function_call_output", call_id: id, output: tool.output });
    }
    const added = between(1200, 6000) + tools.reduce((sum, tool) => sum + tool.output.length / 3.5, 0);
    const input = context + Math.round(added);
    const usage = { input_tokens: input, cached_input_tokens: context, cache_write_input_tokens: 0, output_tokens: between(150, 1400), reasoning_output_tokens: between(80, 900) };
    usage.total_tokens = usage.input_tokens + usage.output_tokens;
    total += usage.total_tokens;
    context = input;
    push("event_msg", { type: "token_count", info: { last_token_usage: usage, total_token_usage: { total_tokens: total }, model_context_window: 400_000 } });
  };
  const shell = (cmd, output, ms) => ({ name: "exec_command", args: { cmd }, output: `Exit code: ${/FAIL|error/.test(output) ? 1 : 0}\nWall time: ${(ms / 1000).toFixed(1)} seconds\nOutput:\n${output}`, ms });
  const patch = (path) => ({ name: "apply_patch", args: { input: `*** Begin Patch\n*** Update File: ${cwd}/${path}\n@@\n-import { Chart } from "chart-lib";\n+const Chart = lazy(() => import("chart-lib"));\n*** End Patch` }, output: "Success. Updated the following files:\nM " + path, ms: 200 });

  user("Cut the dashboard's cold start under two seconds (TASK-0103). Measure first, then fix the biggest cause, and show before and after numbers.");
  request([shell("pnpm build && pnpm measure:cold-start", "cold start: 4.82 s (p50 of 5)\nmain.js: 1.94 MB", 48_000)], "Measuring the current cold start first.");
  request([shell("pnpm analyze-bundle --json | head -40", "chart-lib 812 KB\nmoment 290 KB\nicons 214 KB\n…", 21_000)]);
  request([shell("rg -n \"from \\\"chart-lib\\\"\" src", "src/dashboard/Revenue.tsx:3\nsrc/dashboard/Usage.tsx:2\nsrc/dashboard/Funnel.tsx:4", 400)]);
  request([patch("src/dashboard/Revenue.tsx"), patch("src/dashboard/Usage.tsx"), patch("src/dashboard/Funnel.tsx")], "chart-lib is 42% of the bundle and only the charts use it. Loading it lazily.");
  request([shell("pnpm build && pnpm measure:cold-start", "src/dashboard/Funnel.tsx(9,3): error TS2786: 'Chart' cannot be used as a JSX component.", 31_000)]);
  request([patch("src/dashboard/Funnel.tsx")]);
  request([shell("pnpm build && pnpm measure:cold-start", "cold start: 2.61 s (p50 of 5)\nmain.js: 1.12 MB", 46_000)]);
  user("Good progress. Switch to the cheaper model for the moment.js swap, it is mechanical.");
  model = "gpt-6-luna";
  effort = "medium";
  turn();
  request([shell("rg -l \"from \\\"moment\\\"\" src | wc -l", "23", 300)], "Replacing moment with date-fns across 23 files.");
  for (let i = 0; i < 6; i++) request([patch(`src/util/dates-${i + 1}.ts`), patch(`src/reports/period-${i + 1}.ts`)]);
  t += 50_000;
  push("compacted", { message: "" });
  push("event_msg", { type: "context_compacted" });
  context = 26_000;
  request([shell("pnpm test", "Tests: 388 passed, 388 total", 58_000)]);
  request([shell("pnpm build && pnpm measure:cold-start", "cold start: 1.74 s (p50 of 5)\nmain.js: 0.81 MB", 44_000)]);
  request([], "Cold start is 1.74 s, down from 4.82 s: chart-lib now loads lazily (−0.8 MB) and date-fns replaced moment (−0.3 MB).");
  push("event_msg", { type: "task_complete" });
  const name = `rollout-2026-10-21T17-02-00-${CODEX_SESSION}.jsonl`;
  await writeFile(join(folder, name), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

await rm(root, { recursive: true, force: true });
await claude();
await codex();
console.log(`Wrote ${root}`);
