// The session overlay shows agents' shell one-liners one statement per line (public/shell.js). The rewrite must still
// be the same command: breaks only at top-level separators, never inside quotes, $( ) or a subshell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandNames, shellLines } from "./public/shell.js";

test("breaks a one-liner at top-level separators and indents loop bodies", () => {
  assert.equal(shellLines(`cd ~/w && for d in a*; do echo "== $d"; git -C $d status | head -5; done; tail -c 9 x 2>/dev/null`),
    ["cd ~/w &&", "  for d in a*", "do", "  echo \"== $d\"", "  git -C $d status |", "    head -5", "done", "tail -c 9 x 2>/dev/null"].join("\n"));
});

test("never breaks inside quotes, $( ) or a subshell", () => {
  const quoted = `python3 -c 'import a; print(1 | 2)' && echo "x; y" && echo $(date; whoami) && (cd a; ls)`;
  assert.deepEqual(shellLines(quoted).split("\n"), [`python3 -c 'import a; print(1 | 2)' &&`, `  echo "x; y" &&`, "  echo $(date; whoami) &&", "  (cd a; ls)"]);
  assert.equal(shellLines("cat <<EOF\na; b\nEOF"), "cat <<EOF\na; b\nEOF");
});

test("names the programs a command runs, without cd or keywords", () => {
  assert.deepEqual(commandNames(`cd x; for t in a b; do wc -l $t | head; done; if [ -f y ]; then /usr/bin/git log; fi`), ["wc", "head", "git"]);
});

test("a heredoc's body is not read as commands", () => {
  assert.deepEqual(commandNames("python3 - <<'EOF'\nimport re\np = open('x').read()\nEOF\nnode check.js"), ["python3", "node"]);
});
