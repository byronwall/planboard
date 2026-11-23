import assert from "node:assert/strict";
import test from "node:test";
import { referenceLabel, referencePanel, referenceRow, referenceTitle } from "./public/dock.js";

const pr = (number, tone, extra = {}) => ({ role: "resolves", ref: `#${number}`, href: `https://github.com/acme/orbit/pull/${number}`, key: `github:acme/orbit#${number}`, steps: [], meta: { title: `PR ${number}`, state: { done: "Merged", draft: "Draft", open: "Open", closed: "Closed" }[tone], tone }, ...extra });
const issue = { role: "tracks", ref: "ATL-412", href: "https://acme.atlassian.net/browse/ATL-412", key: "jira:ATL-412", steps: [], meta: { title: "Invites by email", state: "In Progress", tone: "progress" } };

test("a PR written as a URL reads as repo#N, short refs keep their spelling", () => {
  assert.equal(referenceLabel({ ref: "https://github.com/acme/spcs-sql-lib/pull/1508", key: "github:acme/spcs-sql-lib#1508" }), "spcs-sql-lib#1508");
  assert.equal(referenceLabel({ ref: "Orbit#12", key: "github:acme/orbit#12" }), "Orbit#12");
});

test("a title that opens with its tracker key drops the key", () => {
  assert.equal(referenceTitle("RAI-56056 Remove the modeler service"), "Remove the modeler service");
  assert.equal(referenceTitle("[MOD-12]: Fix the thing"), "Fix the thing");
  assert.equal(referenceTitle("Fix RAI-1 later"), "Fix RAI-1 later");
});

test("the line paints titles and states from the server's cached metadata, live PRs first", () => {
  const html = referenceRow([issue, pr(1, "done"), pr(2, "draft", { steps: ["W1.2"] }), pr(3, "open")]);
  // Live work leads its role; merged ones sit last, so they are the first to move behind "+N".
  assert.ok(html.indexOf("#2<") < html.indexOf("#3<") && html.indexOf("#3<") < html.indexOf("#1<"));
  assert.match(html, /<span class="doc-dock-ref-title">PR 2<\/span>/);
  // A PR's state is its mark's color, never words that change the line's width; an issue keeps its state words.
  assert.doesNotMatch(html, />Draft</);
  assert.match(html, />In Progress</);
  assert.match(html, /popovertarget="dock-refs"/);
});

test("the panel lists every reference with a tally of where they stand", () => {
  const html = referencePanel([issue, pr(1, "done"), pr(2, "draft"), pr(3, "open"), { role: "resolves", ref: "#bad", href: "", key: "", steps: [] }]);
  assert.match(html, /Resolves <span>4 · 1 open · 1 draft · 1 merged · 1 unlinked<\/span>/);
  assert.match(html, /Tracks <span>1 · 1 open<\/span>/);
  assert.match(html, /class="dock-ref-row is-unlinked"/);
});
