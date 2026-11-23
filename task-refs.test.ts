import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskDocument } from "./server.ts";
import { planningErrors } from "./check-planning.ts";
import { referenceFindings } from "./task-refs.ts";
import { parseWorkBreakdown } from "./public/actions.js";

const path = "tasks/TASK-0042/TASK-0042.md";
const task = (front: string, body = "") => `---
id: TASK-0042
title: Ship invites
summary: Invites by email.
status: active
project: Atlas
tags: []
created: 2026-10-14
updated: 2026-10-14
${front}---

# Ship invites

${body}`;

test("tracks:, resolves: and step (pr:) tags become one list of canonical references", () => {
  const { task: parsed } = parseTaskDocument(path, task("tracks: [ATL-412]\nresolves: [#1857, https://github.com/acme/Orbit/pull/7]\n", `## Work breakdown

- W1: Endpoints [completed] (pr: #1842)
- W2: Mailer [active] {agent, S} (pr: atlas#1857)
`));
  assert.deepEqual(parsed.refs!.map(({ role, ref, key, steps }) => [role, ref, key, steps]), [
    ["tracks", "ATL-412", "linear:ATL-412", []],
    ["resolves", "#1857", "github:acme/atlas#1857", ["W2"]],
    ["resolves", "https://github.com/acme/Orbit/pull/7", "github:acme/Orbit#7", []],
    ["resolves", "#1842", "github:acme/atlas#1842", ["W1"]],
  ]);
});

test("a step's (pr:) tag doesn't disturb the rest of its line", () => {
  const [node] = parseWorkBreakdown("- W2: Mailer [active] (after: W1) {agent, S} (pr: #1857, Orbit#9)").nodes;
  assert.deepEqual([node.title, node.status, node.deps, node.kind, node.prs], ["Mailer", "active", ["W1"], "agent", ["#1857", "Orbit#9"]]);
});

test("lint rejects a reference the viewer can't link and a list that isn't inline", () => {
  assert.match(planningErrors(path, task("resolves: [the mailer PR]\n")).join("\n"), /resolves names “the mailer PR”.*viewer can link/);
  assert.match(planningErrors(path, task("tracks: ATL-412\n")).join("\n"), /tracks as an inline list/);
});

test("planboard refs flags unlisted PRs carrying the tracked key, and missing lines", () => {
  const prs = [
    { slug: "acme/atlas", number: 1871, title: "ATL-412 Pending invites list", branch: "alex/pending", state: "open" },
    { slug: "acme/atlas", number: 1857, title: "ATL-412 mailer", branch: "x", state: "open" },
    { slug: "acme/atlas", number: 1900, title: "Unrelated", branch: "atl-4120-other", state: "open" },
  ];
  const listed = referenceFindings(path, task("tracks: [ATL-412]\nresolves: [#1857]\n"), prs, {});
  assert.deepEqual(listed.map((finding) => finding.problem), ["#1871 “ATL-412 Pending invites list” (open) carries ATL-412 but isn't listed"]);

  const bare = referenceFindings(path, task("", "Tracked as ATL-412 and OPS-9; ATL-412 again. Fixed in #1857.\n"), [], {});
  assert.deepEqual(bare.map((finding) => finding.problem), ["no tracks: line, but the text names ATL-412, OPS-9", "no resolves: line, but the text links #1857"]);
  assert.match(bare[0].fix, /tracks: \[ATL-412\]/);
});

test("an empty tracks: or resolves: list means none on purpose", () => {
  const prs = [{ slug: "acme/atlas", number: 1871, title: "ATL-412 Pending invites list", branch: "", state: "open" }];
  const text = "Tracked as ATL-412. See #1857 for the earlier fix.\n";
  assert.deepEqual(referenceFindings(path, task("tracks: []\nresolves: []\n", text), prs, {}), []);
  assert.deepEqual(parseTaskDocument(path, task("tracks: []\nresolves: []\n")).task.noRefs, ["tracks", "resolves"]);
  // An empty resolves: still asks for tracks:, and a listed issue still flags PRs that carry it unless resolves: is [].
  assert.deepEqual(referenceFindings(path, task("resolves: []\n", text), prs, {}).map((finding) => finding.problem), ["no tracks: line, but the text names ATL-412"]);
  assert.equal(referenceFindings(path, task("tracks: [ATL-412]\nresolves: []\n", text), prs, {}).length, 0);
});
