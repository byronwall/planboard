import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createSessionReader } from "./agent-session.ts";

// examples/agent-logs holds fictional logs written by scripts/agent-logs-sample.mjs.
const logs = join(import.meta.dirname, "examples/agent-logs");
const read = createSessionReader({ home: "/nonexistent", claudeConfig: join(logs, "claude"), codexHome: join(logs, "codex") });

test("a Claude Code session reads its requests once, its subagents, tool results and compaction", async () => {
  const session = (await read("claude:5e55a0c1-0103-4a11-9c3e-ac0e00000101"))!;
  assert.equal(session.title, "TASK-0101 · Ship workspace invites");
  assert.deepEqual(session.agents.map((agent) => agent.label), ["Main", "Expired invite page", "Find invite email templates"]);
  assert.equal(session.requests.filter((request) => request.agent === 0).length, 20);
  // Input is the whole prompt: fresh + cache read + cache write.
  for (const request of session.requests) assert.ok(request.input >= request.cached + request.cacheWrite);
  const failed = session.tools.filter((tool) => tool.error);
  assert.deepEqual(failed.map((tool) => tool.name), ["Bash", "Bash"]);
  assert.ok(session.tools.every((tool) => tool.dur !== null && tool.size > 0 && tool.request >= 0));
  // Each Agent call points at the subagent it started.
  assert.deepEqual(session.tools.filter((tool) => tool.name === "Agent").map((tool) => tool.spawns).sort(), [1, 2]);
  assert.deepEqual(session.marks.map((mark) => mark.kind), ["effort", "compact"]);
  assert.equal(session.messages.length, 2);
  assert.equal(session.cost, 4.82);
  assert.equal(session.costExact, true);
});

test("a Codex rollout ties each tool call to the request that made it", async () => {
  const session = (await read("codex:019a0101-c01d-7a57-a7e5-ac0e00000103"))!;
  assert.equal(session.branch, "perf/cold-start");
  assert.equal(session.requests.length, 17);
  assert.deepEqual(session.marks.map((mark) => `${mark.kind}:${mark.label}`), ["model:gpt-6-luna", "effort:medium", "compact:Compacted"]);
  // Codex logs usage after the response, so a call belongs to the next request.
  const first = session.tools[0];
  assert.ok(session.requests[first.request].t >= first.t);
  assert.equal(session.tools.filter((tool) => tool.error).length, 1);
  assert.equal(session.requests[0].window, 400_000);
  assert.equal(await read("codex:00000000-0000-4000-8000-000000000000"), null);
});
