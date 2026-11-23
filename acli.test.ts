import assert from "node:assert/strict";
import test from "node:test";
import { AcliUnavailableError, createAcliRunner } from "./acli.ts";

const quiet = { info() {}, warn() {} };

test("a hung acli is killed at its deadline and pauses later calls", async () => {
  const runner = createAcliRunner({ timeoutMs: 300, log: quiet });
  const started = Date.now();
  await assert.rejects(runner.run(["/bin/sleep"], ["30"]), AcliUnavailableError);
  assert.ok(Date.now() - started < 5_000, "the child is killed, not waited on");
  await assert.rejects(runner.run(["/bin/echo"], ["ok"]), AcliUnavailableError, "paused calls fail fast without spawning");
});

test("only `concurrency` calls run at once; the rest queue", async () => {
  let live = 0;
  let peak = 0;
  const exec = async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 20)); live--; return "[]"; };
  const runner = createAcliRunner({ exec, concurrency: 2, log: quiet });
  await Promise.all(Array.from({ length: 9 }, () => runner.run(["acli"], ["jira"])));
  assert.equal(peak, 2);
});

test("an outage pauses with a doubling delay, logs once, and resumes on success", async () => {
  let clock = 0;
  let down = true;
  let calls = 0;
  const logs: string[] = [];
  const exec = async () => { calls++; if (down) throw new Error("✗ Failure: oauth2: cannot fetch token: 503 Service Unavailable"); return "ok"; };
  const runner = createAcliRunner({ exec, now: () => clock, firstPauseMs: 1_000, maxPauseMs: 3_000, log: { info: (m: string) => logs.push(`info ${m}`), warn: (m: string) => logs.push(`warn ${m}`) } });

  await assert.rejects(runner.run(["acli"], ["x"]), AcliUnavailableError);
  assert.equal(runner.state().pauseMs, 1_000);
  await assert.rejects(runner.run(["acli"], ["x"]), AcliUnavailableError);
  assert.equal(calls, 1, "no call while paused");

  clock = 1_000;
  await assert.rejects(runner.run(["acli"], ["x"]), AcliUnavailableError);
  assert.equal(runner.state().pauseMs, 2_000);
  clock = 3_000;
  await assert.rejects(runner.run(["acli"], ["x"]), AcliUnavailableError);
  assert.equal(runner.state().pauseMs, 3_000, "capped");

  down = false;
  clock = 6_000;
  assert.equal(await runner.run(["acli"], ["x"]), "ok");
  assert.equal(runner.state().pauseMs, 0);
  assert.equal(logs.filter((l) => l.startsWith("warn")).length, 1, "one warning per outage");
  assert.equal(logs.filter((l) => l.startsWith("info")).length, 1, "one line on recovery");
});

test("an ordinary failure, such as an unknown key, passes through without pausing", async () => {
  const exec = async () => { throw new Error("✗ Error: The value 'RAI-0' does not exist for the field 'key'."); };
  const runner = createAcliRunner({ exec, log: quiet });
  await assert.rejects(runner.run(["acli"], ["x"]), (error) => !(error instanceof AcliUnavailableError));
  assert.equal(runner.state().pauseMs, 0);
});
