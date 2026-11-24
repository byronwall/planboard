# planboard

## 0.2.0

### Minor Changes

- cee64ad: Open any local Claude Code or Codex session from Chat Threads or a chat link and study it in full: tokens per request on a chart, a timeline of requests, messages, compactions and model changes, and every tool call with its arguments, duration, result and failures, by tool, file and subagent.
- 5148c0b: Steps and the Outbox filter by typed words (with -word to exclude and highlighted matches) and by Task, Kind, Size, Status, Age and Draft menus with live counts; every filter stays in the URL.
- 4c7f57c: Tasks name their canonical issue and PRs with `tracks:` and `resolves:` front matter (and `(pr: …)` on a step), shown on one line in the task page's sticky header with live titles and states; `planboard refs` lists PRs and issues those lines are missing. Document titles now run the full width of the reader column.
- cee64ad: The session overlay finds problems and waste in an agent session (failed and retried calls, polling loops, repeated reads, large results, cache misses), shows what the agent said in a timeline grouped by turn, lays out commands and edits as code and diffs, saves your notes on any tool call, and turns findings and notes into a review prompt.

### Patch Changes

- 91be880: A PR overview opened from a document or link no longer fails when your review is requested on a PR someone else has approved.
- abe9a58: Check and repair a missing upstream when opening an existing PR worktree in VS Code.
- 390a091: Document tables no longer flash when fitting their columns would change the table's own width back and forth.
- 9f4432a: Every open PR without a worktree now offers Check out and Check out and open in VS Code, in any tracked repository, not only ones with a local server command.
- c070196: Jira lookups through acli no longer pile up when Atlassian sign-in is down: each call is killed after 90 seconds, at most four run at once, and an outage pauses all acli calls with a growing delay instead of retrying.
- e79aaf7: The canonical references line under a task's title paints complete with no layout shift, shows URL refs as repo#N, moves what doesn't fit behind +N, and opens every reference in an aligned panel
- 4bacbd5: The document dock's Diagrams panel opens the viewer on every diagram it counts, grouped in the rail by the document that embeds each one.
- bd16320: The session overlay gives the lists more room: the totals sit beside a shorter chart that you can widen or hide. Call lists preview two lines with More, and the timeline can show only your messages. Idle gaps longer than the prompt cache break the chart and the timeline, with clock times on both sides. The timeline shows each tool's kind and what it touched, your messages stand out, and the agent menu describes every subagent. Shell commands are split into statements and colored.
- 6ae9b41: The Setup page is now four tabs (Integrations, Settings, Prompts, Files) with one list and an inspector each, a filter that searches every tab, and the selected row kept in the URL.
- c4768a4: Track the matching origin branch when checking out PR worktrees, including existing local branches and repository-specific worktree commands.
- c583b90: `tracks: []` and `resolves: []` mark a task as having no tracking issue or resolving PR on purpose, so `planboard refs` stops flagging it.
- 2dec382: Verify the repository, worktree and upstream for PR checkout and local server actions, and share checkout setup across simultaneous requests.

## 0.1.1

### Patch Changes

- 4fe956f: Planboard installs from npm: run `npx planboard init` in an empty folder, then `npx planboard` to serve it. No clone is needed.
