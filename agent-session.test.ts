import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createSessionReader } from "./agent-session.ts";
import { createSessionNotes } from "./session-notes.ts";
import { findings } from "./public/session-findings.js";

// examples/agent-logs holds fictional logs written by scripts/agent-logs-sample.mjs.
const logs = join(import.meta.dirname, "examples/agent-logs");
const read = createSessionReader({ home: "/nonexistent", claudeConfig: join(logs, "claude"), codexHome: join(logs, "codex") });

test("a Claude Code session reads its requests once, its subagents, tool results and compaction", async () => {
  const session = (await read("claude:5e55a0c1-0103-4a11-9c3e-ac0e00000101"))!;
  assert.equal(session.title, "TASK-0101 · Ship workspace invites");
  assert.deepEqual(session.agents.map((agent) => agent.label), ["Main", "Expired invite page", "Find invite email templates"]);
  assert.equal(session.requests.filter((request) => request.agent === 0).length, 26);
  // Input is the whole prompt: fresh + cache read + cache write.
  for (const request of session.requests) assert.ok(request.input >= request.cached + request.cacheWrite);
  const failed = session.tools.filter((tool) => tool.error);
  assert.deepEqual(failed.map((tool) => tool.name), ["Bash", "Edit", "Edit", "Bash"]);
  // What the agent said before its calls rides on the request.
  assert.equal(session.requests[0].text, "I'll read the invite model and the current routes first.");
  assert.equal(new Set(session.tools.map((tool) => tool.id)).size, session.tools.length);
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

test("findings flag blind retries and polling, but not a test run again after an edit", async () => {
  const session = (await read("claude:5e55a0c1-0103-4a11-9c3e-ac0e00000101"))!;
  const list = findings(session);
  const kinds = list.map((finding: any) => finding.kind);
  assert.deepEqual([...new Set(kinds)].sort(), ["big", "cache", "failed", "handoff", "repeat", "reread", "slow"]);
  const repeat = list.filter((finding: any) => finding.kind === "repeat");
  assert.equal(repeat.length, 1);
  assert.match(repeat[0].detail, /gh pr checks 231/);
  assert.match(list.find((finding: any) => finding.title.startsWith("Edit failed")).detail, /run again with nothing changed/);
  assert.doesNotMatch(list.find((finding: any) => finding.title.startsWith("Bash failed")).detail, /run again/);
  assert.equal(list.find((finding: any) => finding.kind === "handoff").agent, 1);
});

test("a session note round-trips through its Markdown file", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-notes-"));
  const notes = createSessionNotes(root);
  const key = "claude:5e55a0c1-0103-4a11-9c3e-ac0e00000101";
  const { notes: [note] } = await notes.change({ key, op: "add", title: "Invites", note: { call: "toolu_1", name: "Bash", time: "10:25", quote: "gh pr checks", body: "Use --watch." } });
  assert.match(await readFile(join(root, "reference/session-notes/claude-5e55a0c1-0103-4a11-9c3e-ac0e00000101.md"), "utf8"), /### `Bash` · 10:25 · call toolu_1/);
  assert.deepEqual((await notes.list(key)).notes.map((item) => [item.call, item.quote, item.body]), [["toolu_1", "gh pr checks", "Use --watch."]]);
  assert.equal((await notes.change({ key, op: "delete", id: note.id })).notes.length, 0);
  await assert.rejects(notes.list("claude:../../etc"), /Not a session key/);
});
