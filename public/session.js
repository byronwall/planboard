import { escapeHtml, renderMarkdown } from "./markdown.js";
import { showTip, hideTip } from "./code.js";
import { GLYPHS, brandMark } from "./icons.js";
import { modelInfo } from "./chat-threads.js";
import { announceClosed, createOverlay, setOverlayParams } from "./overlay.js";
import { formatDateTime } from "./dates.js";
import { withNote } from "./config.js";
import { openNotePopover } from "./note-popover.js";
import { command, findings, findingsMarkdown, parseArgs, toolFiles } from "./session-findings.js";
import { commandNames, shellHtml, shellLines } from "./shell.js";

// One agent chat session read in full (`?session=claude:<id>` or `codex:<id>`). A line of totals and a chart of every
// model request sit over six tabs beside an inspector: Findings (problems and waste, worst first, from
// session-findings.js), the Timeline of turns and requests with what the agent said, tool calls by tool, files the tools
// touched, the agents, and the user's notes. A note sits on one tool call and is saved in the workspace
// (session-notes.ts); Review with an agent turns the findings and notes into a prompt. Data comes from /api/chat-session.

export { toolFiles };
const TABS = { findings: "Findings", timeline: "Timeline", tools: "Tools", files: "Files", agents: "Agents", notes: "Notes" };
const glyph = (name, className = "code-icon") => `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${GLYPHS[name]}</svg>`;
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const num = (value) => value ? compact.format(value) : "0";
const exact = (value) => Math.round(value).toLocaleString();
const usd = (value) => value === null || value === undefined ? "—" : value < 0.01 ? "<$0.01" : `$${value.toFixed(value < 10 ? 2 : 1)}`;
const pct = (part, whole) => whole ? `${Math.round(100 * part / whole)}%` : "—";
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
export function span(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${String(Math.round(ms % 60_000 / 1000)).padStart(2, "0")}s`;
  return `${Math.floor(ms / 3_600_000)}h ${String(Math.round(ms % 3_600_000 / 60_000)).padStart(2, "0")}m`;
}
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
// A clock without AM/PM for dense rows; the turn rows above them carry the full time.
const short = (t) => clock(t).replace(/\s?[AP]M$/i, "");
const minute = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const modelName = (id) => modelInfo(id)?.name || id || "—";
const home = (text) => String(text ?? "").replace(/\/Users\/[^/\s"]+/g, "~");
const agentName = (index) => index ? data.agents[index].label : "Main agent";
// Each agent keeps one color in the chart, the timeline and the agent menu. The main agent is neutral.
const AGENT_COLORS = ["#5b6b85", "#8b4fd8", "#1f8aa8", "#c0662b", "#2f9e78", "#c23d7a", "#7a8a1f", "#b7791f", "#3f6fd8"];
const agentColor = (index) => AGENT_COLORS[index ? 1 + (index - 1) % (AGENT_COLORS.length - 1) : 0];
const agentDot = (index) => `<i class="session-dot" style="--a:${agentColor(index)}"></i>`;
const ACTIONS = { Read: "read", NotebookRead: "read", view_image: "read", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", apply_patch: "edit", Write: "write" };
// An idle stretch longer than the 5-minute prompt cache: the chart breaks there and the timeline says so.
const IDLE = 5 * 60_000;
const idleLabel = (ms) => ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h${Math.round(ms % 3_600_000 / 60_000) ? `${Math.round(ms % 3_600_000 / 60_000)}m` : ""}`;
const TOOL_KINDS = [
  [/^(?:Read|NotebookRead|view_image)$/, "read", "file-text"], [/^(?:Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/, "edit", "pen-line"],
  [/^(?:Bash|BashOutput|shell|local_shell|exec_command|write_stdin|KillShell)$/, "shell", "terminal"], [/^(?:Grep|Glob|LS|WebSearch|web_search|ToolSearch)$/, "search", "search"],
  [/^(?:Task|Agent|spawn_agent|send_input|wait)$/, "agent", "bot"], [/^(?:WebFetch)$/, "web", "globe"], [/^mcp__/, "mcp", "network"],
];
const toolKind = (name) => { const hit = TOOL_KINDS.find(([pattern]) => pattern.test(name)); return hit ? { kind: hit[1], icon: hit[2] } : { kind: "other", icon: "code" }; };
const toolLabel = (name) => name.startsWith("mcp__") ? name.split("__").slice(2).join("__") || name : name;
// A few words on what a call touched, for the timeline: the commands a shell call ran, a file's name, a pattern.
function callHint(tool) {
  const shell = command(tool);
  if (shell) return commandNames(shell).join(" ");
  const files = toolFiles(tool);
  if (files.length) return files.map((path) => path.split("/").filter(Boolean).at(-1)).join(", ");
  const args = parseArgs(tool);
  const value = args?.pattern ?? args?.query ?? args?.description ?? args?.url;
  return typeof value === "string" ? value : "";
}

// What each kind of finding means and what usually does better, for the inspector.
const ADVICE = {
  failed: "A failed call costs a round trip, and its error stays in the context. Several failures on one step usually mean the agent is missing a fact: a path, a flag, or the file's current text.",
  repeat: "The same call again and again with nothing changed in between is polling or a loop. A blocking command (a --watch or wait flag) or one background job with a single check at the end does it in one request.",
  reread: "Each read puts the whole file into the context again. Unless the file changed, the first read is still there to look at.",
  handoff: "A subagent starts with an empty context, so it reads what its parent already knew. Put the facts or excerpts it needs in its prompt.",
  big: "A large result is read again by every later request until the context compacts. Ask for less: a quieter reporter, a filter, head or tail, or a summary.",
  cache: "A request normally reads the earlier conversation from the prompt cache at a tenth of the price. When the cache expires (Claude keeps a prompt for 5 minutes, or an hour with 1-hour writes), the next request pays for the whole context again.",
  slow: "The agent waits while a call runs. Long builds and test runs can run in the background, or be narrowed to what changed.",
  window: "Near the context window the session compacts and drops detail. Subagents or a fresh session keep the main context small.",
};
const SEVERITY_LABEL = { problem: "Problems", waste: "Waste", info: "Worth a look" };
const SEVERITY_ICON = { problem: "circle-alert", waste: "zap", info: "info" };

// The first meaningful line of a call's arguments: the command, the path, the pattern, else compact JSON.
function argSummary(tool) {
  const args = parseArgs(tool);
  if (!args) return home(tool.args.split("\n").find((line) => line.trim()) || "");
  const files = toolFiles(tool);
  if (files.length) return home(files.map(relative).join(", "));
  const first = command(tool) || (args.pattern ?? args.query ?? args.url ?? args.title ?? args.description ?? args.prompt ?? args.message ?? args.code ?? args.task_name);
  if (first !== undefined && first !== "") return home(Array.isArray(first) ? first.join(" ") : String(first)).replace(/\s+/g, " ");
  return home(JSON.stringify(args)).slice(0, 300);
}
// Markdown read as one line of plain text, for previews: no emphasis marks, code ticks or link targets.
const plain = (text) => String(text ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/(\*\*|__|`|^#+\s*|^\s*[-*]\s+)/gm, "").replace(/\s+/g, " ").trim();
const relative = (path) => { const root = data?.cwd ? `${data.cwd.replace(/\/$/, "")}/` : ""; return root && path.startsWith(root) ? path.slice(root.length) : home(path); };

let dialog = null;
let data = null;
let notes = [];
let notesPath = "";
let found = [];
let notify = () => {};
let ui = { tab: "", agent: 0, pick: null, find: "", focus: null, menu: false, only: false };
export const setSessionNotice = (show) => { notify = show; };
// The chart sits beside the totals (compact), spans the overlay taller (wide), or folds away (hidden); the choice is
// kept per browser.
const CHART_KEY = "plan-viewer:session-chart";
const chartMode = () => { try { const value = localStorage.getItem(CHART_KEY); return value === "0" || value === "hidden" ? "hidden" : value === "wide" ? "wide" : "compact"; } catch { return "compact"; } };
const setChartMode = (mode) => { try { localStorage.setItem(CHART_KEY, mode); } catch {} };

export function openSession(key, { tab = "", agent = "", pick = "" } = {}) {
  if (!dialog) build();
  ui = { tab: TABS[tab] ? tab : "", agent: agent === "all" ? -1 : Number(agent) || 0, pick: pick || null, find: "", focus: null, menu: false, only: ui.only };
  dialog.dataset.key = key;
  setOverlayParams({ session: key });
  dialog.querySelector('[data-s="head"]').hidden = false;
  dialog.querySelector('[data-s="head"]').innerHTML = `<div class="session-title"><h3>Loading session…</h3></div><span class="code-spacer"></span>${closeButton()}`;
  dialog.querySelector('[data-s="main"]').innerHTML = `<p class="code-muted session-note">Reading the log…</p>`;
  dialog.dataset.sessionState = "loading";
  if (!dialog.open) { dialog.showModal(); dialog.focus({ preventScroll: true }); }
  Promise.all([fetch(`/api/chat-session?key=${encodeURIComponent(key)}`).then(async (response) => {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not read this session.");
    return body;
  }), loadNotes(key)]).then(([body]) => {
    if (dialog.dataset.key !== key) return;
    data = body;
    found = findings(data);
    if (ui.agent >= data.agents.length) ui.agent = 0;
    ui.tab ||= found.length ? "findings" : "timeline";
    if (ui.pick?.startsWith("x:")) ui.focus = ui.pick.slice(2);
    render();
    reveal();
    dialog.dataset.sessionState = "ready";
  }).catch((error) => {
    if (dialog.dataset.key !== key) return;
    dialog.querySelector('[data-s="head"]').hidden = false;
    dialog.querySelector('[data-s="head"]').innerHTML = `<div class="session-title"><h3>Session not found</h3><p class="code-muted">${escapeHtml(key)}</p></div><span class="code-spacer"></span>${closeButton()}`;
    dialog.querySelector('[data-s="main"]').innerHTML = `<p class="session-note">${escapeHtml(error.message)} Planboard reads Claude Code and Codex logs from this computer's ~/.claude and ~/.codex folders.</p>`;
    dialog.dataset.sessionState = "error";
  });
}

async function loadNotes(key) {
  const body = await fetch(`/api/session-notes?key=${encodeURIComponent(key)}`).then((response) => response.json()).catch(() => ({}));
  notes = body.notes || [];
  notesPath = body.path || "";
}

async function changeNote(change) {
  const response = await fetch("/api/session-notes", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: dialog.dataset.key, title: data.title, log: home(data.path), ...change }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Couldn't save the note.");
  notes = body.notes;
  notesPath = body.path;
  renderBody();
}

const closeButton = () => `<button type="button" class="code-icon-button" data-s-close aria-label="Close (Esc)">${glyph("x")}</button>`;

function build() {
  dialog = createOverlay("session-overview");
  dialog.innerHTML = `<header class="code-diff-head session-head" data-s="head"></header><div class="session-main" data-s="main"></div>`;
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    announceClosed();
    setOverlayParams({ session: "", "session-tab": "", "session-agent": "", "session-pick": "" });
    dialog.dataset.key = "";
    hideTip();
  });
  dialog.addEventListener("click", onClick);
  dialog.addEventListener("input", (event) => {
    if (!event.target.matches("[data-s-find]")) return;
    ui.find = event.target.value;
    renderBody();
  });
  dialog.addEventListener("keydown", onKey);
  dialog.addEventListener("pointerover", (event) => {
    const target = event.target.closest("[data-tip]");
    if (target) showTip(target); else hideTip();
  });
  dialog.addEventListener("pointerleave", hideTip);
  new ResizeObserver(() => { if (data && dialog.open) drawChart(); }).observe(dialog);
}

// ---------- Scope ----------

const inScope = (item) => ui.agent < 0 || item.agent === ui.agent;
function scope() {
  const requests = data.requests.map((request, index) => ({ ...request, index })).filter(inScope);
  const tools = data.tools.map((tool, index) => ({ ...tool, index })).filter(inScope);
  return { requests, tools, messages: data.messages.filter(inScope), marks: data.marks.filter(inScope), findings: found.filter(inScope) };
}
const focused = () => found.find((finding) => finding.id === ui.focus) || null;

// Time the main agent sat waiting for the user: from its last request or tool result to the next message.
function waiting() {
  const main = data.messages.filter((message) => message.agent === 0);
  return main.slice(1).reduce((total, message) => {
    const ends = [...data.requests.filter((request) => request.agent === 0 && request.t < message.t).map((request) => request.t),
      ...data.tools.filter((tool) => tool.agent === 0 && tool.t < message.t).map((tool) => tool.t + (tool.dur || 0))];
    return total + (ends.length ? Math.max(0, message.t - Math.max(...ends)) : 0);
  }, 0);
}

function totals({ requests, tools, messages }) {
  const sum = (key) => requests.reduce((total, request) => total + (request[key] || 0), 0);
  const costs = requests.map((request) => request.cost).filter((cost) => cost !== null && cost !== undefined);
  const agents = ui.agent < 0 ? data.agents : [data.agents[ui.agent]];
  const start = Math.min(...agents.map((agent) => agent.start).filter(Boolean));
  const end = Math.max(...agents.map((agent) => agent.end).filter(Boolean));
  return { input: sum("input"), cached: sum("cached"), write: sum("cacheWrite"), output: sum("output"), reasoning: sum("reasoning"),
    cost: ui.agent < 0 && data.costExact ? data.cost : costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    exactCost: ui.agent < 0 && data.costExact, priced: costs.length, requests: requests.length, peak: Math.max(0, ...requests.map((request) => request.input)),
    tools: tools.length, errors: tools.filter((tool) => tool.error).length, messages: messages.length, duration: end - start };
}

// ---------- Render ----------

function render() {
  const head = dialog.querySelector('[data-s="head"]');
  const models = [...new Set(data.requests.filter((request) => request.agent === 0).map((request) => request.model))];
  const efforts = [...new Set(data.requests.filter((request) => request.agent === 0).map((request) => request.effort).filter(Boolean))];
  const folder = data.cwd.split("/").filter(Boolean).at(-1) || "";
  const facts = [models.map(modelName).join(" → "), efforts.join(" → "), folder, data.branch, data.start && formatDateTime(new Date(data.start))].filter(Boolean);
  // The loading header steps aside: the title and totals sit on the left and the chart runs to the top of the overlay.
  head.hidden = true;
  const app = data.provider === "Claude" ? "Claude Code" : "Codex";
  const meta = `<span data-tip="${escapeHtml(home(data.path))}">${escapeHtml(app)}</span> · ${facts.map((fact, index) => index === 2 ? `<span data-tip="${escapeHtml(home(data.cwd))}">${escapeHtml(fact)}</span>` : escapeHtml(fact)).join(" · ")}`;
  const title = `<div class="session-id"><span class="session-mark">${brandMark(data.provider === "Claude" ? "claude" : "codex", `chat-app-mark is-${data.provider.toLowerCase()}`)}</span>
    <div class="session-title"><h3 data-tip="${escapeHtml(data.title)}">${escapeHtml(data.title)}</h3><p class="code-muted">${meta}</p></div></div>`;
  const actions = `<button type="button" class="session-chart-button is-action" data-s-review data-tip="Save a prompt that asks an agent to explain the findings and your notes, and propose lasting fixes">${glyph("sparkles")}Review with an agent</button>
    <a class="session-chart-button is-action" href="${escapeHtml(data.url)}">${glyph("external-link")}Open in ${data.provider === "Claude" ? "Claude" : "Codex"}</a>`;
  const agents = data.agents.length > 1 ? `<div class="session-agent" data-s="agent"></div>` : "";
  const legend = `<span class="session-legend" aria-label="Chart key"><span class="is-cached" data-tip="Prompt tokens read from the prompt cache">Cached</span><span class="is-write" data-tip="Prompt tokens written to the prompt cache">Written</span><span class="is-fresh" data-tip="Prompt tokens neither read from nor written to the cache">Uncached</span><span class="is-output">Output</span><span class="is-cumulative" data-tip="Running total of tokens processed">Total</span><span class="is-idle" data-tip="No request for longer than the 5-minute prompt cache">Idle</span><span class="is-compact">Compacted</span><span class="is-msg" data-tip="Your messages">You</span><span class="is-fail" data-tip="A failed tool call">Failed</span></span>`;
  dialog.querySelector('[data-s="main"]').innerHTML = `<div class="session-top" data-s="top" data-chart="${chartMode()}">
      <div class="session-stats">${title}<span class="session-stat-list" data-s="stats"></span></div>
      <div class="session-chart-panel"><div class="session-chart-bar">${actions}<span class="session-bar-rule"></span>
        <button type="button" class="session-chart-button is-show" data-s-chart="compact" data-tip="Show the chart">${glyph("chart-gantt")}Show chart</button>
        <button type="button" class="session-chart-button is-size" data-s-chart="wide" data-tip="Widen the chart" aria-label="Widen the chart">${glyph("maximize")}</button>
        <button type="button" class="session-chart-button is-size" data-s-chart="compact" data-tip="Put the chart beside the totals" aria-label="Put the chart beside the totals">${glyph("minimize")}</button>
        <button type="button" class="session-chart-button is-size" data-s-chart="hidden" data-tip="Hide the chart" aria-label="Hide the chart">${glyph("eye")}</button>
        <span class="session-focus" data-s="focus"></span>${legend}<span class="code-spacer"></span>${closeButton()}</div>
      <div class="session-chart" data-s="chart"></div></div></div>
    <div class="session-toolbar"><div class="code-segment" role="tablist" aria-label="View">${Object.entries(TABS).filter(([key]) => key !== "agents" || data.agents.length > 1).map(([key, label]) => `<button type="button" role="tab" data-s-tab="${key}" aria-pressed="${ui.tab === key}">${label}<span class="code-count" data-s-count="${key}"></span></button>`).join("")}</div>
      ${agents}<label class="code-filter">${glyph("search")}<input type="search" data-s-find placeholder="Find a tool, file or message…" aria-label="Find in this session" spellcheck="false"></label>
      <span class="code-spacer"></span>
      <button type="button" class="session-only" data-s-only aria-pressed="false" data-tip="Show only your messages, each with the agent's last word" hidden>${glyph("user")}Your messages only</button></div>
    <div class="session-split"><div class="session-list" data-s="list"></div><aside class="session-inspector" data-s="inspector" aria-label="Details"></aside></div>`;
  renderBody();
}

function renderBody() {
  const view = scope();
  const all = totals(view);
  const wait = ui.agent <= 0 ? waiting() : 0;
  const stat = (label, value, tip = "", tone = "") => `<span class="session-stat${tone ? ` is-${tone}` : ""}"${tip ? ` data-tip="${escapeHtml(tip)}"` : ""}><small>${label}</small><b>${value}</b></span>`;
  dialog.querySelector('[data-s="stats"]').innerHTML = [
    stat("Cost", usd(all.cost), all.exactCost ? "Claude Code's own total for this session" : all.priced ? `Estimated from public API prices for ${all.priced} of ${all.requests} requests` : "No price is known for this model", all.cost !== null && !all.exactCost ? "estimate" : ""),
    stat("Requests", exact(all.requests)),
    stat("Input", num(all.input), `${exact(all.input)} prompt tokens: ${exact(all.cached)} read from cache, ${exact(all.write)} written to it, ${exact(all.input - all.cached - all.write)} uncached`),
    stat("Cache read", pct(all.cached, all.input), `${exact(all.cached)} of ${exact(all.input)} prompt tokens came from the prompt cache`),
    stat("Output", num(all.output), `${exact(all.output)} output tokens, ${exact(all.reasoning)} of them reasoning`),
    stat("Peak context", num(all.peak), `The largest single prompt: ${exact(all.peak)} tokens`),
    stat("Tool calls", `${exact(all.tools)}${all.errors ? ` <em>${all.errors} failed</em>` : ""}`),
    stat("Turns", exact(all.messages), "Messages the user typed"),
    stat("Duration", span(all.duration), "First to last logged event"),
    ...(wait > 1000 ? [stat("Waiting on you", span(wait), "Time between the agent's last step and your next message")] : []),
  ].join("");
  for (const button of dialog.querySelectorAll("[data-s-tab]")) button.setAttribute("aria-pressed", String(button.dataset.sTab === ui.tab));
  const picker = dialog.querySelector('[data-s="agent"]');
  if (picker) picker.innerHTML = agentPicker();
  const only = dialog.querySelector("[data-s-only]");
  only.hidden = ui.tab !== "timeline";
  only.setAttribute("aria-pressed", String(ui.only));
  const counts = { findings: view.findings.length, timeline: view.requests.length, tools: new Set(view.tools.map((tool) => tool.name)).size, files: fileRows(view.tools).length, agents: data.agents.length, notes: notes.length };
  for (const count of dialog.querySelectorAll("[data-s-count]")) {
    count.textContent = counts[count.dataset.sCount];
    count.classList.toggle("is-alert", count.dataset.sCount === "findings" && view.findings.some((finding) => finding.severity === "problem"));
  }
  if (ui.tab === "findings" && !ui.pick && view.findings[0]) ui.focus = view.findings[0].id;
  const focus = focused();
  dialog.querySelector('[data-s="focus"]').innerHTML = focus && ui.tab !== "findings" ? `<span data-tip="This finding's requests are lit on the chart and tinted in the timeline">Highlighting <b>${escapeHtml(focus.title)}</b></span><button type="button" class="code-icon-button" data-s-unfocus aria-label="Stop highlighting this finding">${glyph("x")}</button>` : "";
  setOverlayParams({ "session-tab": ui.tab === (found.length ? "findings" : "timeline") ? "" : ui.tab, "session-agent": ui.agent === 0 ? "" : ui.agent < 0 ? "all" : String(ui.agent), "session-pick": ui.pick || "" });
  const list = dialog.querySelector('[data-s="list"]');
  const top = list.scrollTop;
  list.innerHTML = { findings: findingsTable, tools: toolsTable, files: filesTable, agents: agentsTable, notes: notesTable }[ui.tab]?.(view) ?? timelineTable(view);
  list.scrollTop = top;
  dialog.querySelector('[data-s="inspector"]').innerHTML = inspector(view);
  markClamps(dialog.querySelector('[data-s="inspector"]'));
  drawChart();
}

// ---------- Agent picker ----------
// A button names the agent in scope; its menu lists the main agent, each subagent with what it was for, its kind,
// model, size and a bar of when it ran on the session's clock, and All agents.

function agentStats(index) {
  const requests = data.requests.filter((request) => request.agent === index);
  const tools = data.tools.filter((tool) => tool.agent === index);
  const costs = requests.map((request) => request.cost).filter((cost) => cost !== null && cost !== undefined);
  return { requests: requests.length, tools: tools.length, failed: tools.filter((tool) => tool.error).length, cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null };
}

function agentPicker() {
  const current = ui.agent < 0 ? `<span class="session-agent-name">All agents</span><small>${data.agents.length}</small>`
    : `${agentDot(ui.agent)}<span class="session-agent-name">${escapeHtml(agentName(ui.agent))}</span>${ui.agent ? `<small>subagent ${ui.agent} of ${data.agents.length - 1}</small>` : `<small>+${plural(data.agents.length - 1, "subagent")}</small>`}`;
  const button = `<button type="button" class="session-agent-button" data-s-agent-button aria-haspopup="listbox" aria-expanded="${ui.menu}">${glyph("bot")}${current}${glyph("chevron-right", "code-icon session-chevron")}</button>`;
  if (!ui.menu) return button;
  const start = data.start, length = Math.max(1, data.end - data.start);
  const row = (index) => {
    const agent = data.agents[index];
    const stats = agentStats(index);
    const left = 100 * ((agent.start || start) - start) / length, width = Math.max(1.5, 100 * ((agent.end || start) - (agent.start || start)) / length);
    const kind = [agent.type && agent.type !== agent.label ? agent.type : "", modelName(agent.model)].filter((part) => part && part !== "—").join(" · ");
    const facts = [plural(stats.requests, "request"), plural(stats.tools, "call"), stats.failed && `<em>${stats.failed} failed</em>`, span(agent.end - agent.start), stats.cost !== null && usd(stats.cost)].filter(Boolean).join(" · ");
    return `<button type="button" role="option" class="session-agent-option" data-s-agent-pick="${index}" aria-selected="${ui.agent === index}">${agentDot(index)}
      <span class="session-agent-text"><b>${escapeHtml(agentName(index))}</b>${kind ? `<small>${escapeHtml(kind)}</small>` : ""}<span>${facts}</span></span>
      <span class="session-agent-run" data-tip="${escapeHtml(`${agent.start ? clock(agent.start) : "—"} – ${agent.end ? clock(agent.end) : "—"}`)}"><i style="left:${left.toFixed(1)}%;width:${Math.min(width, 100 - left).toFixed(1)}%;--a:${agentColor(index)}"></i></span></button>`;
  };
  const subs = data.agents.map((_, index) => index).slice(1);
  return `${button}<div class="session-agent-menu" role="listbox" aria-label="Agent">${row(0)}
    <p class="session-agent-group">Subagents <small>${subs.length} · started by the main agent</small></p>${subs.map(row).join("")}
    <button type="button" role="option" class="session-agent-option is-all" data-s-agent-pick="-1" aria-selected="${ui.agent < 0}">${glyph("layers")}<span class="session-agent-text"><b>All agents</b><span>Every request on one timeline, each row marked with its agent's color</span></span></button></div>`;
}

function pickAgent(index) {
  ui.agent = index;
  ui.menu = false;
  ui.pick = null;
  renderBody();
  dialog.querySelector("[data-s-agent-button]")?.focus({ preventScroll: true });
}

// ---------- Chart ----------
// One bar per request in scope, in order: the prompt stacked as cache read, cache write and uncached input, the output
// below the axis on its own scale. A line traces the running total of tokens processed. Dashed rules mark compactions;
// triangles on top mark user messages, labels mark model and effort changes, and a red tick marks a failed call. An
// idle stretch longer than the prompt cache breaks the bars with a hatched gap that names its length, and clock labels
// sit on both sides of it. A picked finding lights up its requests and dims the rest.

function drawChart() {
  const host = dialog.querySelector('[data-s="chart"]');
  if (!host || chartMode() === "hidden") return;
  const { requests, messages, marks } = scope();
  const width = Math.max(320, host.clientWidth);
  const height = chartMode() === "wide" ? 200 : Math.max(96, (dialog.querySelector(".session-stats")?.offsetHeight || 150) - 28);
  const pad = { left: 44, right: 50, top: 16, bottom: 16 };
  const outH = chartMode() === "wide" ? 26 : 14;
  const inH = height - pad.top - pad.bottom - outH - 6;
  const base = pad.top + inH;
  if (!requests.length) { host.innerHTML = `<p class="code-muted session-note">No model requests in this scope.</p>`; return; }
  // Bars sit side by side in request order; an idle stretch longer than the prompt cache opens a hatched break.
  const gaps = requests.map((request, index) => index && request.t - requests[index - 1].t > IDLE ? index : 0).filter(Boolean);
  const plot = width - pad.left - pad.right;
  const gapW = gaps.length ? Math.min(40, Math.max(22, plot * 0.04)) : 0;
  const step = (plot - gaps.length * gapW) / requests.length;
  const bar = Math.max(1, Math.min(18, step - (step > 4 ? 1 : 0)));
  const slot = (index) => pad.left + index * step + gaps.filter((gap) => gap <= index).length * gapW;
  const maxIn = Math.max(...requests.map((request) => request.input)) || 1;
  const maxOut = Math.max(...requests.map((request) => request.output)) || 1;
  const window = Math.max(0, ...requests.map((request) => request.window || 0));
  const top = Math.max(maxIn, window && window < maxIn * 1.6 ? window : 0);
  const y = (value) => base - (value / top) * inH;
  const x = (index) => slot(index) + (step - bar) / 2;
  let running = 0;
  const cumulative = requests.map((request) => (running += request.input + request.output));
  const yc = (value) => base - (value / (running || 1)) * inH;
  const at = (t) => { const index = requests.findIndex((request) => request.t >= t); return index < 0 ? requests.length : index; };
  const ticks = [0, 0.5, 1].map((share) => share * top);
  const picked = ui.pick?.startsWith("r") ? Number(ui.pick.slice(1)) : -1;
  const focus = focused();
  const hits = new Set(focus?.requests || []);
  const failed = new Set(data.tools.filter((tool) => tool.error).map((tool) => tool.request));
  const bars = requests.map((request, index) => {
    const fresh = request.input - request.cached - request.cacheWrite;
    const left = x(index);
    const parts = [["cached", request.cached], ["write", request.cacheWrite], ["fresh", fresh]];
    let floor = base;
    const stack = parts.map(([kind, value]) => {
      if (value <= 0) return "";
      const h = (value / top) * inH;
      floor -= h;
      return `<rect class="is-${kind}" x="${left}" y="${floor}" width="${bar}" height="${Math.max(h, 0.5)}"/>`;
    }).join("");
    const out = (request.output / maxOut) * outH;
    const classes = [request.index === picked && "is-picked", ui.agent < 0 && request.agent && "is-sub", hits.has(request.index) && "is-hit"].filter(Boolean).join(" ");
    const fail = failed.has(request.index) ? `<rect class="session-fail" x="${left}" y="${base + 6 + outH + 1}" width="${Math.max(bar, 2)}" height="3"/>` : "";
    const who = ui.agent < 0 && request.agent ? `<rect class="session-who" x="${left}" y="${base + 1}" width="${bar}" height="2" style="fill:${agentColor(request.agent)}"/>` : "";
    return `<g class="session-bar ${classes}" data-s-pick="r${request.index}"><rect class="session-hit" x="${slot(index)}" y="${pad.top}" width="${Math.max(step, 1)}" height="${height - pad.top - pad.bottom}"/>${stack}${who}<rect class="is-output" x="${left}" y="${base + 6}" width="${bar}" height="${Math.max(out, 0.5)}"/>${fail}</g>`;
  }).join("");
  // The running total steps flat across a break, so the jump in time does not read as a jump in tokens.
  const line = cumulative.map((value, index) => `${index ? (gaps.includes(index) ? `L${(slot(index) - gapW).toFixed(1)},${yc(cumulative[index - 1]).toFixed(1)}M${slot(index).toFixed(1)},${yc(cumulative[index - 1]).toFixed(1)}L` : "L") : "M"}${(x(index) + bar / 2).toFixed(1)},${yc(value).toFixed(1)}`).join("");
  const breaks = gaps.map((index) => {
    const left = slot(index) - gapW, idle = requests[index].t - requests[index - 1].t, next = requests[index];
    const cold = next.input && next.cached / next.input < 0.5;
    const tip = `Idle ${span(idle)}: ${clock(requests[index - 1].t)} → ${clock(next.t)}\n${cold ? `Longer than the prompt cache keeps a prompt, so the next request wrote ${exact(next.input - next.cached)} tokens again.` : "The prompt cache still held the context."}`;
    const mid = left + gapW / 2;
    return `<g class="session-break${cold ? " is-cold" : ""}" data-tip="${escapeHtml(tip)}"><rect x="${left + 2}" y="${pad.top - 2}" width="${gapW - 4}" height="${inH + outH + 10}" rx="3"/>
      <path d="M${mid - 4},${base + 6}l3,-6M${mid + 1},${base + 6}l3,-6"/><text x="${mid}" y="${pad.top + inH / 2}" text-anchor="middle">${escapeHtml(idleLabel(idle))}</text></g>`;
  }).join("");
  const compacts = marks.filter((mark) => mark.kind === "compact").map((mark) => {
    const left = slot(at(mark.t)) - 0.5;
    const tip = `Compacted${mark.trigger ? ` (${mark.trigger})` : ""}${mark.before ? `: ${exact(mark.before)} → ${exact(mark.after || 0)} tokens` : ""} at ${clock(mark.t)}`;
    return `<g class="session-compact" data-tip="${escapeHtml(tip)}"><line x1="${left}" x2="${left}" y1="${pad.top - 4}" y2="${base + 6 + outH}"/><rect x="${left - 5}" y="${pad.top - 6}" width="10" height="${inH + outH}" fill="transparent"/></g>`;
  });
  // A model change and an effort change at the same request share one label.
  const changes = [...Map.groupBy(marks.filter((mark) => mark.kind !== "compact"), (mark) => at(mark.t))].map(([index, group]) => {
    const left = slot(index) - 0.5;
    const label = group.map((mark) => mark.kind === "model" ? modelName(mark.label) : mark.label).join(" · ");
    const tip = group.map((mark) => `${mark.kind === "model" ? "Model" : "Effort"} changed to ${mark.kind === "model" ? modelName(mark.label) : mark.label}`).join("\n") + ` at ${clock(group[0].t)}`;
    return `<g class="session-change" data-tip="${escapeHtml(tip)}"><line x1="${left}" x2="${left}" y1="${pad.top}" y2="${pad.top + 12}"/><text x="${left + 4}" y="${pad.top + 10}">${escapeHtml(label)}</text></g>`;
  });
  const msgSvg = messages.map((message) => {
    const left = slot(at(message.t)) + Math.min(step, bar) / 2;
    return `<path class="session-msg" d="M${left - 4},${pad.top - 12}h8l-4,6z" data-tip="${escapeHtml(`${clock(message.t)} · ${message.text.slice(0, 160)}`)}" data-s-pick="m${data.messages.indexOf(message)}"/>`;
  }).join("");
  // Clock labels: the first and last request, both sides of every break, then more where they fit.
  const wanted = [[0, "start"], [requests.length - 1, "end"], ...gaps.flatMap((index) => [[index, "start"], [index - 1, "end"]])];
  for (let px = 170; px < plot - 80; px += 170) wanted.push([Math.min(requests.length - 1, Math.round(requests.findIndex((_, index) => slot(index) - pad.left >= px))), "middle"]);
  const labels = [];
  for (const [index, anchor] of wanted) {
    if (index < 0 || labels.some((label) => label.index === index)) continue;
    const text = minute(requests[index].t);
    const cx = anchor === "start" ? slot(index) : anchor === "end" ? slot(index) + step : x(index) + bar / 2;
    const w = text.length * 5.6;
    const [from, to] = anchor === "start" ? [cx, cx + w] : anchor === "end" ? [cx - w, cx] : [cx - w / 2, cx + w / 2];
    if (labels.some((label) => from < label.to + 8 && to > label.from - 8)) continue;
    labels.push({ index, anchor, cx, from, to, text });
  }
  const timeSvg = labels.map((label) => `<text class="session-axis is-time" x="${label.cx}" y="${height - 3}" text-anchor="${label.anchor}">${escapeHtml(label.text)}</text>`).join("");
  const windowLine = window && window <= top ? `<line class="session-window" x1="${pad.left}" x2="${width - pad.right}" y1="${y(window)}" y2="${y(window)}"/><text class="session-axis" x="${width - pad.right - 4}" y="${y(window) - 3}" text-anchor="end">context window ${num(window)}</text>` : "";
  host.innerHTML = `<svg width="${width}" height="${height}" role="img" aria-label="Tokens per request"${hits.size ? ' class="is-focused"' : ""}>
    ${ticks.map((value) => `<line class="session-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(value)}" y2="${y(value)}"/><text class="session-axis" x="${pad.left - 6}" y="${y(value) + 3}" text-anchor="end">${num(value)}</text>`).join("")}
    <text class="session-axis" x="${pad.left - 6}" y="${base + 6 + outH / 2 + 3}" text-anchor="end">out</text>
    ${breaks}${windowLine}${bars}<path class="session-cumulative" d="${line}"/>
    <text class="session-axis is-cumulative" x="${width - pad.right + 6}" y="${yc(running) + 3}">${num(running)}</text>
    <text class="session-axis" x="${width - pad.right + 6}" y="${base + 6 + outH / 2 + 3}">${num(maxOut)}</text>
    ${timeSvg}${compacts.join("")}${changes.join("")}${msgSvg}</svg>`;
  for (const group of host.querySelectorAll(".session-bar")) {
    const index = Number(group.dataset.sPick.slice(1));
    const request = data.requests[index];
    const said = request.text ? `\n${request.text.split("\n")[0].slice(0, 120)}` : "";
    group.dataset.tip = `#${requests.findIndex((item) => item.index === index) + 1} · ${clock(request.t)} · ${agentName(request.agent)} · ${modelName(request.model)}\nInput ${exact(request.input)} (${pct(request.cached, request.input)} cache read, ${exact(request.cacheWrite)} written)\nOutput ${exact(request.output)}${request.reasoning ? ` (${exact(request.reasoning)} reasoning)` : ""}${said}`;
  }
}

// ---------- Tables ----------

function matches(...values) {
  const query = ui.find.trim().toLowerCase();
  return !query || values.some((value) => String(value ?? "").toLowerCase().includes(query));
}
const noted = (tool) => notes.filter((note) => note.call && note.call === tool.id);
const impact = (finding) => finding.tokens ? `~${num(finding.tokens)} tokens` : finding.ms ? span(finding.ms) : "";

function findingsTable({ findings: list }) {
  const rows = list.filter((finding) => matches(finding.title, finding.detail));
  if (!rows.length) return `<p class="session-note">${list.length ? "Nothing matches." : "No problems found: no failed calls, loops, repeated reads, large results or cache misses."}</p>`;
  const showAgent = ui.agent < 0 && data.agents.length > 1;
  return `<table class="code-table session-table session-findings"><tbody>${[...Map.groupBy(rows, (finding) => finding.severity)].map(([severity, group]) => `
    <tr class="session-group"><th colspan="4">${SEVERITY_LABEL[severity]}</th></tr>
    ${group.map((finding) => `<tr class="code-row is-${finding.severity}${ui.pick === `x:${finding.id}` ? " is-picked" : ""}" data-s-pick="x:${escapeHtml(finding.id)}" tabindex="0">
      <td class="session-num">${glyph(SEVERITY_ICON[finding.severity])}</td>
      <td><b>${escapeHtml(finding.title)}</b><span class="session-detail">${escapeHtml(home(finding.detail))}</span></td>
      ${showAgent ? `<td class="session-agent-cell">${escapeHtml(agentName(finding.agent))}</td>` : ""}
      <td class="session-n" data-tip="${finding.tokens ? `About ${exact(finding.tokens)} tokens: characters ÷ 4, counted again for each later request that carried them` : "Time spent"}">${impact(finding)}</td></tr>`).join("")}`).join("")}</tbody></table>`;
}

// Turn summaries: everything in scope from one of the user's messages to the next.
function turnStats(message, messages, requests, tools) {
  const next = messages.find((other) => other.t > message.t)?.t ?? Infinity;
  const own = requests.filter((request) => request.t >= message.t && request.t < next);
  const calls = tools.filter((tool) => tool.t >= message.t && tool.t < next);
  const end = Math.max(message.t, ...own.map((request) => request.t), ...calls.map((tool) => tool.t + (tool.dur || 0)));
  const costs = own.map((request) => request.cost).filter((cost) => cost !== null && cost !== undefined);
  return { requests: own, calls, failed: calls.filter((tool) => tool.error).length, ms: end - message.t, cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null };
}

function timelineTable({ requests, tools, messages, marks }) {
  const byRequest = Map.groupBy(tools, (tool) => tool.request);
  const showAgent = ui.agent < 0;
  const hits = new Set(focused()?.requests || []);
  const width = showAgent ? 9 : 8;
  const rows = [
    ...messages.map((message, turn) => {
      const index = data.messages.indexOf(message);
      if (!matches(message.text)) return { t: message.t, order: 0, html: "" };
      const stats = turnStats(message, messages, requests, tools);
      const facts = [plural(stats.requests.length, "request"), plural(stats.calls.length, "call"), stats.failed && `<em>${stats.failed} failed</em>`, span(stats.ms), stats.cost !== null && usd(stats.cost)].filter(Boolean).join(" · ");
      // With only your messages showing, each turn also shows the agent's last word, so the list reads as the conversation.
      const reply = ui.only && stats.requests.findLast((request) => request.text);
      return { t: message.t, order: 0, html: `<tr class="code-row session-msg-row${ui.pick === `m${index}` ? " is-picked" : ""}" data-s-pick="m${index}" tabindex="0"><td class="session-num">${glyph("user")}</td><td class="session-time">${clock(message.t)}</td><td colspan="${width - 2}"><div class="session-turn-line"><b class="session-turn-label">Turn ${turn + 1}</b><span class="session-msg-text">${escapeHtml(message.text)}</span><span class="session-turn">${facts}</span></div>${reply ? `<span class="session-reply">${glyph("bot")}${escapeHtml(plain(home(reply.text)))}</span>` : ""}</td></tr>` };
    }),
    ...(ui.only ? [] : [
    ...marks.map((mark) => ({ t: mark.t, order: 1, html: `<tr class="session-mark-row is-${mark.kind}"><td class="session-num">${glyph(mark.kind === "compact" ? "layers" : "settings")}</td><td class="session-time">${clock(mark.t)}</td><td colspan="${width - 2}">${mark.kind === "compact" ? `Context compacted${mark.trigger ? ` (${escapeHtml(mark.trigger)})` : ""}${mark.before ? `: ${exact(mark.before)} → ${exact(mark.after || 0)} tokens` : ""}` : `${mark.kind === "model" ? "Model" : "Effort"} changed to <b>${escapeHtml(mark.kind === "model" ? modelName(mark.label) : mark.label)}</b>`}</td></tr>` })),
    // An idle stretch longer than the prompt cache, between two requests in scope.
    ...requests.slice(1).map((request, position) => {
      const prior = requests[position], idle = request.t - prior.t;
      if (idle <= IDLE || ui.find.trim()) return null;
      const cold = request.input && request.cached / request.input < 0.5;
      return { t: prior.t + 1, order: 3, html: `<tr class="session-gap-row${cold ? " is-cold" : ""}"><td class="session-num">${glyph("hourglass")}</td><td class="session-time">${minute(prior.t)}</td><td colspan="${width - 2}"><b>${span(idle)} idle</b>${cold ? ` · the prompt cache expired, so the next request wrote ${num(request.input - request.cached)} tokens again` : " · the prompt cache held"}</td></tr>` };
    }).filter(Boolean),
    ...requests.map((request, position) => {
      const own = byRequest.get(request.index) || [];
      if (!matches(request.model, request.text, ...own.flatMap((tool) => [tool.name, tool.args]))) return { t: request.t, order: 2, html: "" };
      const names = [...Map.groupBy(own, (tool) => tool.name)].map(([name, calls]) => {
        const failed = calls.filter((tool) => tool.error).length;
        const { kind, icon } = toolKind(name);
        const hints = [...new Set(calls.map(callHint).filter(Boolean))];
        const hint = hints.length ? `<code>${escapeHtml(home(hints.slice(0, 2).join(", ")).slice(0, 60))}${hints.length > 2 ? ` +${hints.length - 2}` : ""}</code>` : "";
        return `<span class="session-chip is-${kind}${failed ? " is-error" : ""}"${name.startsWith("mcp__") ? ` data-tip="${escapeHtml(name)}"` : ""}>${glyph(failed ? "triangle-alert" : icon)}<b>${escapeHtml(toolLabel(name))}</b>${calls.length > 1 ? `<i>×${calls.length}</i>` : ""}${hint}</span>`;
      }).join("");
      const pinned = own.some((tool) => noted(tool).length) ? `<span class="session-chip is-note" data-tip="You left a note here">${glyph("pen-line")}</span>` : "";
      const fresh = request.input - request.cached;
      const cache = request.input ? request.cached / request.input : 1;
      return { t: request.t, order: 2, html: `<tr class="code-row session-req${request.text ? " has-text" : ""}${ui.pick === `r${request.index}` ? " is-picked" : ""}${hits.has(request.index) ? " is-hit" : ""}" data-s-pick="r${request.index}" tabindex="0">
        <td class="session-num">${position + 1}</td><td class="session-time" data-tip="${escapeHtml(`${new Date(request.t).toLocaleString()} · ${modelName(request.model)}${request.effort ? ` · ${request.effort}` : ""}`)}">${short(request.t)}</td>
        ${showAgent ? `<td class="session-agent-cell" style="--a:${agentColor(request.agent)}">${agentDot(request.agent)}${escapeHtml(request.agent ? data.agents[request.agent].label : "Main")}</td>` : ""}
        <td class="session-step">${request.text ? `<span class="session-said">${escapeHtml(plain(request.text))}</span>` : ""}</td><td class="session-did"><span class="session-tools">${names}${pinned}</span></td>
        <td class="session-n is-context">${num(request.input)}</td>
        <td class="session-n${cache < 0.5 ? " is-warn" : " is-soft"}">${pct(request.cached, request.input)}</td>
        <td class="session-n${fresh >= 20_000 ? " is-heavy" : " is-soft"}" data-tip="${exact(fresh)} tokens not read from cache">${num(fresh)}</td>
        <td class="session-n is-soft">${num(request.output)}</td></tr>` };
    })]),
  ].sort((a, b) => a.t - b.t || a.order - b.order).map((row) => row.html).join("");
  return `<table class="code-table session-table session-timeline"><thead><tr><th class="session-num">#</th><th>Time</th>${showAgent ? '<th class="session-agent-head">Agent</th>' : ""}<th>Said</th><th class="session-did-head">Did</th><th class="session-n" data-tip="Prompt tokens: the context this request read">Context</th><th class="session-n" data-tip="Share of the prompt read from cache">Cache</th><th class="session-n" data-tip="Prompt tokens not read from cache">New</th><th class="session-n">Output</th></tr></thead><tbody>${rows || `<tr><td colspan="${width}" class="session-note">Nothing matches.</td></tr>`}</tbody></table>`;
}

function toolStats(tools) {
  return [...Map.groupBy(tools, (tool) => tool.name)].map(([name, calls]) => {
    const durations = calls.map((tool) => tool.dur).filter((dur) => dur !== null && dur !== undefined).sort((a, b) => a - b);
    return { name, calls, errors: calls.filter((tool) => tool.error).length, time: durations.reduce((a, b) => a + b, 0),
      median: durations.length ? durations[Math.floor(durations.length / 2)] : null, max: durations.at(-1) ?? null, size: calls.reduce((sum, tool) => sum + tool.size, 0) };
  }).sort((a, b) => b.calls.length - a.calls.length || a.name.localeCompare(b.name));
}

function toolsTable({ tools }) {
  const stats = toolStats(tools).filter((row) => matches(row.name));
  const most = Math.max(1, ...stats.map((row) => row.size));
  return `<table class="code-table session-table"><thead><tr><th>Tool</th><th class="session-n">Calls</th><th class="session-n">Failed</th><th class="session-n" data-tip="Time from the call to its result, summed">Total time</th><th class="session-n">Median</th><th class="session-n">Longest</th><th data-tip="Tokens of results returned to the model (characters ÷ 4)">Result tokens</th></tr></thead><tbody>${stats.map((row) => `<tr class="code-row${ui.pick === `t:${row.name}` ? " is-picked" : ""}" data-s-pick="t:${escapeHtml(row.name)}" tabindex="0">
    <td class="session-tool-name">${escapeHtml(row.name)}</td>
    <td class="session-n">${row.calls.length}</td>
    <td class="session-n${row.errors ? " is-error" : ""}">${row.errors || ""}</td>
    <td class="session-n">${span(row.time)}</td><td class="session-n">${span(row.median)}</td><td class="session-n">${span(row.max)}</td>
    <td class="session-meter" data-tip="${exact(row.size)} characters"><i style="width:${(100 * row.size / most).toFixed(1)}%"></i><span>${num(Math.round(row.size / 4))}</span></td></tr>`).join("") || `<tr><td colspan="7" class="session-note">No tool calls.</td></tr>`}</tbody></table>`;
}

function fileRows(tools) {
  const files = new Map();
  for (const tool of tools) {
    for (const path of toolFiles(tool)) {
      const row = files.get(path) || { path, read: 0, edit: 0, write: 0, other: 0, calls: [], last: 0, agents: new Set() };
      row[ACTIONS[tool.name] || "other"]++;
      row.calls.push(tool);
      row.agents.add(tool.agent);
      row.last = Math.max(row.last, tool.t);
      files.set(path, row);
    }
  }
  return [...files.values()].sort((a, b) => b.calls.length - a.calls.length || a.path.localeCompare(b.path));
}

function filesTable({ tools }) {
  const rows = fileRows(tools).filter((row) => matches(row.path));
  const cell = (value, tone = "") => `<td class="session-n${tone}">${value || ""}</td>`;
  return `<table class="code-table session-table"><thead><tr><th>File</th><th class="session-n">Reads</th><th class="session-n">Edits</th><th class="session-n">Writes</th><th class="session-n" data-tip="Searches and other tools that named this path">Other</th>${ui.agent < 0 && data.agents.length > 1 ? '<th class="session-n">Agents</th>' : ""}<th>Last</th></tr></thead><tbody>${rows.map((row) => `<tr class="code-row${ui.pick === `f:${row.path}` ? " is-picked" : ""}" data-s-pick="f:${escapeHtml(row.path)}" tabindex="0">
    <td class="session-path" data-tip="${escapeHtml(home(row.path))}">${escapeHtml(relative(row.path))}</td>${cell(row.read, row.read > 1 && !row.edit && !row.write ? " is-warn" : "")}${cell(row.edit)}${cell(row.write)}${cell(row.other)}${ui.agent < 0 && data.agents.length > 1 ? cell(row.agents.size > 1 ? row.agents.size : "") : ""}<td class="session-time">${clock(row.last)}</td></tr>`).join("") || `<tr><td colspan="7" class="session-note">No tool call named a file.</td></tr>`}</tbody></table>`;
}

// Each agent's activity on one shared clock, so parallel and idle stretches show at a glance.
function agentsTable() {
  const start = data.start, length = Math.max(1, data.end - data.start);
  return `<table class="code-table session-table"><thead><tr><th>Agent</th><th>Model</th><th class="session-activity-head">Active <small>${clock(start)} – ${clock(data.end)}</small></th><th class="session-n">Requests</th><th class="session-n">Cost</th><th class="session-n">Tool calls</th><th class="session-n">Findings</th><th class="session-n">Duration</th></tr></thead><tbody>${data.agents.map((agent, index) => {
    if (!matches(agent.label, agent.type, agent.description)) return "";
    const requests = data.requests.filter((request) => request.agent === index);
    const tools = data.tools.filter((tool) => tool.agent === index);
    const errors = tools.filter((tool) => tool.error).length;
    const costs = requests.map((request) => request.cost).filter((cost) => cost !== null && cost !== undefined);
    const own = found.filter((finding) => finding.agent === index);
    const left = 100 * ((agent.start || start) - start) / length, width = Math.max(0.6, 100 * ((agent.end || start) - (agent.start || start)) / length);
    const ticks = requests.map((request) => `<b style="left:${(100 * (request.t - start) / length).toFixed(2)}%"></b>`).join("");
    return `<tr class="code-row${ui.agent === index ? " is-picked" : ""}" data-s-agent-row="${index}" tabindex="0">
      <td>${index ? glyph("bot") : ""}<b>${escapeHtml(agentName(index))}</b>${agent.type && agent.type !== agent.label ? ` <small class="code-muted">${escapeHtml(agent.type)}</small>` : ""}</td>
      <td class="session-model">${escapeHtml(modelName(agent.model))}</td>
      <td class="session-activity" data-tip="${escapeHtml(`${agent.start ? clock(agent.start) : "—"} – ${agent.end ? clock(agent.end) : "—"}`)}"><i style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></i>${ticks}</td>
      <td class="session-n">${requests.length}</td><td class="session-n">${costs.length ? usd(costs.reduce((a, b) => a + b, 0)) : "—"}</td>
      <td class="session-n">${tools.length}${errors ? ` <em class="is-error">${errors} failed</em>` : ""}</td>
      <td class="session-n${own.some((finding) => finding.severity === "problem") ? " is-error" : ""}">${own.length || ""}</td><td class="session-n">${span(agent.end - agent.start)}</td></tr>`;
  }).join("")}</tbody></table>`;
}

function notesTable() {
  const add = `<div class="session-list-bar"><span>${notes.length ? `Saved in <code>${escapeHtml(notesPath)}</code>` : "Add a note on any tool call from its Note button, or on the whole session."}</span><span class="code-spacer"></span><button type="button" class="code-bar-button" data-s-note-session>${glyph("pen-line")}Note on the session</button></div>`;
  const rows = notes.filter((note) => matches(note.name, note.quote, note.body));
  return `${add}<table class="code-table session-table"><tbody>${rows.map((note) => {
    const tool = data.tools.findIndex((item) => item.id === note.call);
    return `<tr class="code-row${ui.pick === `n:${note.id}` ? " is-picked" : ""}" data-s-pick="n:${escapeHtml(note.id)}" tabindex="0"><td class="session-num">${glyph("pen-line")}</td>
      <td class="session-time">${escapeHtml(note.call ? note.time : "Session")}</td><td class="session-note-cell"><b>${escapeHtml(note.call ? note.name : "Whole session")}</b>${note.quote ? ` <code>${escapeHtml(note.quote.split("\n")[0])}</code>` : ""}${note.call && tool < 0 ? ' <small class="code-muted">(call not in this log)</small>' : ""}<span class="session-detail">${escapeHtml(note.body)}</span></td></tr>`;
  }).join("")}</tbody></table>`;
}

// ---------- Inspector ----------

const fence = (text, language = "") => { const tick = "`".repeat(Math.max(3, ...[...String(text).matchAll(/`+/g)].map((match) => match[0].length + 1))); return renderMarkdown(`${tick}${language}\n${home(text)}\n${tick}`); };
const language = (path) => ({ ts: "typescript", tsx: "typescript", js: "javascript", mjs: "javascript", py: "python", sql: "sql", md: "markdown", json: "json", sh: "bash", css: "css", html: "html" })[String(path).split(".").at(-1)] || "";
const pathLine = (path, extra = "") => `<p class="session-path-line">${glyph("file-text")}<span data-tip="${escapeHtml(home(path))}">${escapeHtml(relative(path))}</span>${extra}</p>`;

// A call's arguments laid out for its kind: a command, a diff, a file, a prompt; anything else as JSON.
function callBody(tool) {
  const args = parseArgs(tool);
  const shell = command(tool);
  if (shell) return `${args?.description ? `<p class="session-shell-why">${escapeHtml(args.description)}</p>` : ""}<pre class="session-shell is-block">${shellHtml(shellLines(home(shell)))}</pre>`;
  if (!args) return tool.args.includes("*** Begin Patch") ? fence(tool.args.replace(/^\*\*\* (?:Begin|End) Patch\n?/gm, ""), "diff") : fence(tool.args);
  if (typeof args.input === "string" && args.input.includes("*** Begin Patch")) return fence(args.input.replace(/^\*\*\* (?:Begin|End) Patch\n?/gm, ""), "diff");
  if (/^(?:Edit|MultiEdit)$/.test(tool.name)) {
    const edits = Array.isArray(args.edits) ? args.edits : [args];
    return `${pathLine(args.file_path)}${fence(edits.map((edit) => [...String(edit.old_string ?? "").split("\n").map((line) => `-${line}`), ...String(edit.new_string ?? "").split("\n").map((line) => `+${line}`)].join("\n")).join("\n@@\n"), "diff")}`;
  }
  if (tool.name === "Write") return `${pathLine(args.file_path)}${fence(String(args.content ?? ""), language(args.file_path))}`;
  if (/^(?:Read|NotebookRead|view_image)$/.test(tool.name)) return pathLine(args.file_path || args.path || "", args.offset || args.limit ? ` <small>lines ${args.offset || 1}–${(args.offset || 1) + (args.limit || 0)}</small>` : "");
  const prompt = args.prompt ?? args.message ?? args.task;
  if (typeof prompt === "string" && prompt.length > 40) return `${args.description ? `<p><b>${escapeHtml(args.description)}</b>${args.subagent_type ? ` <small class="code-muted">${escapeHtml(args.subagent_type)}</small>` : ""}</p>` : ""}<div class="session-prose markdown">${renderMarkdown(home(prompt))}</div>`;
  if (args.pattern !== undefined) return `<p class="session-path-line">${glyph("search")}<code>${escapeHtml(args.pattern)}</code>${args.path ? ` in ${escapeHtml(relative(args.path))}` : ""}${args.glob ? ` <small>${escapeHtml(args.glob)}</small>` : ""}</p>`;
  return fence(JSON.stringify(args, null, 2), "json");
}

function noteList(tool) {
  return noted(tool).map((note) => `<div class="session-user-note"><header>${glyph("pen-line")}<small>${escapeHtml(note.at)}</small><span class="code-spacer"></span><button type="button" class="code-icon-button" data-s-note-delete="${escapeHtml(note.id)}" aria-label="Delete this note">${glyph("trash-2")}</button></header><div class="markdown">${renderMarkdown(note.body)}</div></div>`).join("");
}

function toolBlock(tool) {
  const index = data.tools.indexOf(tool);
  const spawn = tool.spawns !== undefined ? `<button type="button" class="code-bar-button" data-s-agent-row="${tool.spawns}">${glyph("bot")}Open subagent: ${escapeHtml(data.agents[tool.spawns].label)}</button>` : "";
  const cut = tool.size > tool.result.length;
  return `<section class="session-call${tool.error ? " is-error" : ""}" id="session-call-${index}"><header><b>${escapeHtml(tool.name)}</b>${tool.via ? ` <small>in ${escapeHtml(tool.via)}</small>` : ""}${tool.error ? `<span class="session-failed">${glyph("triangle-alert")}Failed</span>` : ""}<span class="code-spacer"></span><small>${clock(tool.t)} · ${span(tool.dur)} · ${num(Math.round(tool.size / 4))} tokens</small>
      <button type="button" class="session-note-button" data-s-note="${index}" data-tip="Note what this call was for, or what would have been better">${glyph("pen-line")}Note</button></header>
    ${callBody(tool)}${spawn}${noteList(tool)}
    ${tool.result ? `<p class="session-label">Result${cut ? ` <small>(first ${exact(tool.result.length)} of ${exact(tool.size)} characters)</small>` : ""}</p><pre class="session-code">${escapeHtml(home(tool.result))}</pre>` : `<p class="session-label code-muted">No result logged.</p>`}</section>`;
}

// One line per call, for lists in the inspector; a click shows the call's request in the timeline.
// Each call: its time, then the tool (in lists of several tools) above what it ran, cut to two lines with More to read
// the rest, then its duration.
function callRows(calls, { name = true } = {}) {
  return `<div class="session-calls">${calls.map((tool) => {
    const { kind, icon } = toolKind(tool.name);
    // A leading `cd` becomes "in <folder>" in the header, so both preview lines show what ran.
    const shell = command(tool) ? home(command(tool)) : "";
    const cd = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/.exec(shell);
    const folder = cd ? cd[1].replace(/^["']|["']$/g, "") : "";
    const body = shell ? `<code class="session-shell">${shellHtml(shellLines(cd ? shell.slice(cd[0].length) : shell))}</code>` : `<span class="session-args">${escapeHtml(argSummary(tool))}</span>`;
    const chip = name ? `<span class="session-chip is-${kind}${tool.error ? " is-error" : ""}"${tool.name.startsWith("mcp__") ? ` data-tip="${escapeHtml(tool.name)}"` : ""}>${glyph(tool.error ? "triangle-alert" : icon)}<b>${escapeHtml(toolLabel(tool.name))}</b></span>` : "";
    const place = folder ? `<span class="session-call-folder" data-tip="${escapeHtml(`cd ${folder}`)}">in ${escapeHtml(folder.replace(/\/$/, "").split("/").at(-1))}</span>` : "";
    return `<div class="code-row session-call-row${tool.error ? " is-error" : ""}" data-s-goto="${tool.request}" data-s-call="${data.tools.indexOf(tool)}" tabindex="0">
      <span class="session-time">${clock(tool.t)}</span>
      <div class="session-call-main">${chip || place ? `<div class="session-call-head">${chip}${place}</div>` : ""}${clamp(body, 2)}</div>
      <span class="session-call-side">${tool.error && !name ? glyph("triangle-alert", "code-icon is-error") : ""}${noted(tool).length ? glyph("pen-line", "code-icon is-note") : ""}${span(tool.dur)}</span></div>`;
  }).join("")}</div>`;
}

// Long text shows its first lines; More (shown only when the text is cut) opens the rest in place.
const clamp = (html, lines) => `<div class="session-clamp" style="--lines:${lines}"><div class="session-clamp-body">${html}</div><button type="button" class="session-more" data-s-more hidden>More</button></div>`;
function markClamps(root) {
  for (const box of root.querySelectorAll(".session-clamp:not(.is-open)")) {
    const body = box.firstElementChild;
    box.querySelector("[data-s-more]").hidden = body.scrollHeight <= body.clientHeight + 1;
  }
}

function inspector(view) {
  const first = { findings: view.findings[0] && `x:${view.findings[0].id}`, tools: toolStats(view.tools)[0] && `t:${toolStats(view.tools)[0].name}`,
    files: fileRows(view.tools)[0] && `f:${fileRows(view.tools)[0].path}`, notes: notes[0] && `n:${notes[0].id}`,
    timeline: ui.only && view.messages[0] ? `m${data.messages.indexOf(view.messages[0])}` : "" }[ui.tab];
  const pick = ui.pick || first || (view.requests[0] ? `r${view.requests[0].index}` : "");
  if (pick.startsWith("x:")) {
    const finding = found.find((item) => item.id === pick.slice(2));
    if (!finding) return "";
    const calls = finding.calls.map((index) => data.tools[index]);
    const requests = finding.calls.length ? [] : finding.requests.map((index) => data.requests[index]);
    return `<h4>${glyph(SEVERITY_ICON[finding.severity], `code-icon is-${finding.severity}`)}${escapeHtml(finding.title)}</h4>
      ${clamp(`<p>${escapeHtml(home(finding.detail))}</p>`, 4)}
      <dl class="session-facts">${[["Agent", agentName(finding.agent)], ["Impact", finding.tokens ? `about ${exact(finding.tokens)} tokens` : finding.ms ? span(finding.ms) : "—"], ...(finding.cost ? [["Cost", usd(finding.cost)]] : [])].map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>
      <div class="session-advice">${escapeHtml(ADVICE[finding.kind] || "")}</div>
      <p class="session-label">${calls.length ? plural(calls.length, "call") : plural(requests.length, "request")} · lit up on the chart</p>
      ${calls.length ? callRows(calls) : `<table class="session-calls"><tbody>${requests.map((request) => `<tr class="code-row" data-s-goto="${data.requests.indexOf(request)}" tabindex="0"><td class="session-time">${clock(request.t)}</td><td>${escapeHtml(agentName(request.agent))}</td><td class="session-n">${num(request.input - request.cached)} new</td><td class="session-n">${usd(request.cost)}</td></tr>`).join("")}</tbody></table>`}`;
  }
  if (pick.startsWith("r")) {
    const index = Number(pick.slice(1));
    const request = data.requests[index];
    if (!request) return "";
    const tools = data.tools.filter((tool) => tool.request === index);
    const fresh = request.input - request.cached - request.cacheWrite;
    const facts = [
      ["Time", `${new Date(request.t).toLocaleString()}`], ["Agent", agentName(request.agent)],
      ["Model", `${modelName(request.model)}${request.effort ? ` · ${request.effort} effort` : ""}`],
      ["Input", `${exact(request.input)} = ${exact(request.cached)} cache read + ${exact(request.cacheWrite)} cache write + ${exact(fresh)} uncached`],
      ["Output", `${exact(request.output)}${request.reasoning ? ` (${exact(request.reasoning)} reasoning)` : ""}${request.thinkingMs ? ` · thought ${span(request.thinkingMs)}` : ""}`],
      ...(request.window ? [["Context", `${pct(request.input, request.window)} of ${exact(request.window)}`]] : []),
      ...(request.stop ? [["Stop", request.stop.replaceAll("_", " ")]] : []),
      ["Cost", `${usd(request.cost)}${request.cost !== null ? " (estimate)" : ""}`],
    ];
    const hits = found.filter((finding) => finding.requests.includes(index));
    const line = [`${num(request.input)} in (${pct(request.cached, request.input)} cached)`, `${num(request.output)} out`, request.thinkingMs && `thought ${span(request.thinkingMs)}`, usd(request.cost)].filter(Boolean).join(" · ");
    return `<h4>Request ${view.requests.findIndex((item) => item.index === index) + 1}<small class="code-muted"> · ${escapeHtml(agentName(request.agent))} · ${escapeHtml(modelName(request.model))}</small></h4>
      <p class="code-muted session-request-line" data-tip="${escapeHtml(facts.map(([label, value]) => `${label}: ${value}`).join("\n"))}">${escapeHtml(line)}</p>
      ${hits.map((finding) => `<button type="button" class="session-finding-link is-${finding.severity}" data-s-finding="${escapeHtml(finding.id)}">${glyph(SEVERITY_ICON[finding.severity])}${escapeHtml(finding.title)}</button>`).join("")}
      ${request.text ? `<p class="session-label">The agent said</p><div class="session-prose markdown">${renderMarkdown(home(request.text))}</div>` : ""}
      <p class="session-label">${tools.length ? plural(tools.length, "tool call") : "No tool calls"}</p>${tools.map(toolBlock).join("")}`;
  }
  if (pick.startsWith("m")) {
    const message = data.messages[Number(pick.slice(1))];
    if (!message) return "";
    const { requests, tools, messages } = view;
    const stats = turnStats(message, messages, requests, tools);
    const reply = stats.requests.findLast((request) => request.text);
    return `<h4>Turn ${messages.indexOf(message) + 1}</h4><p class="code-muted">${new Date(message.t).toLocaleString()} · ${[plural(stats.requests.length, "request"), plural(stats.calls.length, "call"), stats.failed && `${stats.failed} failed`, span(stats.ms), stats.cost !== null && usd(stats.cost)].filter(Boolean).join(" · ")}</p>
      <p class="session-label">You asked</p><div class="session-message markdown">${renderMarkdown(message.text, "")}</div>
      ${reply ? `<p class="session-label">The agent's last word</p><div class="session-prose markdown">${renderMarkdown(home(reply.text))}</div>` : ""}
      ${stats.calls.length ? `<p class="session-label">What it did</p>${callRows(stats.calls)}` : ""}`;
  }
  if (pick.startsWith("n:")) {
    const note = notes.find((item) => item.id === pick.slice(2));
    if (!note) return "";
    const tool = data.tools.find((item) => item.id === note.call);
    return `<h4>Note${note.call ? ` on ${escapeHtml(note.name)}` : " on the session"}</h4><p class="code-muted">${escapeHtml(note.at)} · <code>${escapeHtml(notesPath)}</code></p>
      ${tool ? toolBlock(tool) : `<div class="session-user-note"><header>${glyph("pen-line")}<small>${escapeHtml(note.at)}</small><span class="code-spacer"></span><button type="button" class="code-icon-button" data-s-note-delete="${escapeHtml(note.id)}" aria-label="Delete this note">${glyph("trash-2")}</button></header><div class="markdown">${renderMarkdown(note.body)}</div></div>`}`;
  }
  if (pick.startsWith("t:") || pick.startsWith("f:")) {
    const key = pick.slice(2);
    const calls = pick.startsWith("t:") ? view.tools.filter((tool) => tool.name === key) : view.tools.filter((tool) => toolFiles(tool).includes(key));
    const own = calls.map((tool) => data.tools[tool.index]);
    return `<h4>${escapeHtml(pick.startsWith("t:") ? key : relative(key))}</h4><p class="code-muted">${plural(calls.length, "call")}${calls.some((tool) => tool.error) ? ` · ${calls.filter((tool) => tool.error).length} failed` : ""}</p>${callRows(own, { name: pick.startsWith("f:") })}`;
  }
  return "";
}

// ---------- Events ----------

function onClick(event) {
  if (event.target === dialog) return;
  if (event.target.closest("[data-s-close]")) return dialog.close();
  const more = event.target.closest("[data-s-more]");
  if (more) {
    const box = more.closest(".session-clamp");
    box.classList.toggle("is-open");
    more.textContent = box.classList.contains("is-open") ? "Less" : "More";
    return;
  }
  if (event.target.closest("[data-s-review]")) return review(event.target.closest("[data-s-review]"));
  const size = event.target.closest("[data-s-chart]");
  if (size) {
    setChartMode(size.dataset.sChart);
    dialog.querySelector('[data-s="top"]').dataset.chart = size.dataset.sChart;
    hideTip();
    return drawChart();
  }
  if (event.target.closest("[data-s-only]")) { ui.only = !ui.only; ui.pick = null; return renderBody(); }
  const agentPick = event.target.closest("[data-s-agent-pick]");
  if (agentPick) return pickAgent(Number(agentPick.dataset.sAgentPick));
  if (event.target.closest("[data-s-agent-button]")) return setMenu(!ui.menu);
  if (ui.menu && !event.target.closest(".session-agent-menu")) setMenu(false);
  const note = event.target.closest("[data-s-note]");
  if (note) return addNote(note, data.tools[Number(note.dataset.sNote)]);
  if (event.target.closest("[data-s-note-session]")) return addNote(event.target.closest("[data-s-note-session]"), null);
  const remove = event.target.closest("[data-s-note-delete]");
  if (remove) return changeNote({ op: "delete", id: remove.dataset.sNoteDelete }).catch((error) => notify(error.message, true));
  if (event.target.closest("[data-s-unfocus]")) { ui.focus = null; return renderBody(); }
  const tab = event.target.closest("[data-s-tab]");
  if (tab) { ui.tab = tab.dataset.sTab; ui.pick = null; return renderBody(); }
  const finding = event.target.closest("[data-s-finding]");
  if (finding) { ui.tab = "findings"; ui.pick = `x:${finding.dataset.sFinding}`; ui.focus = finding.dataset.sFinding; renderBody(); return reveal(); }
  const agentRow = event.target.closest("[data-s-agent-row]");
  if (agentRow) { ui.agent = Number(agentRow.dataset.sAgentRow); ui.tab = "timeline"; ui.pick = null; return render(); }
  const goto = event.target.closest("[data-s-goto]");
  if (goto) {
    ui.tab = "timeline";
    ui.pick = `r${goto.dataset.sGoto}`;
    const call = data.tools[Number(goto.dataset.sCall)];
    if (call && !inScope(call)) ui.agent = -1;
    renderBody();
    reveal();
    if (call) dialog.querySelector(`#session-call-${goto.dataset.sCall}`)?.scrollIntoView({ block: "start" });
    return;
  }
  const pick = event.target.closest("[data-s-pick]");
  if (pick) {
    ui.pick = pick.dataset.sPick;
    if (ui.pick.startsWith("x:")) ui.focus = ui.pick.slice(2);
    if (pick.closest('[data-s="chart"]')) { ui.tab = "timeline"; renderBody(); return reveal(); }
    renderBody();
  }
}

function setMenu(open) {
  ui.menu = open;
  const picker = dialog.querySelector('[data-s="agent"]');
  if (!picker) return;
  picker.innerHTML = agentPicker();
  if (open) (picker.querySelector('[aria-selected="true"]') || picker.querySelector("[data-s-agent-pick]"))?.focus({ preventScroll: true });
  else picker.querySelector("[data-s-agent-button]")?.focus({ preventScroll: true });
}

function reveal() {
  dialog.querySelector('[data-s="list"] .is-picked')?.scrollIntoView({ block: "nearest" });
}

function addNote(anchor, tool) {
  openNotePopover(anchor, {
    heading: tool ? `Note on ${tool.name} at ${clock(tool.t)}` : "Note on the whole session",
    detail: tool ? argSummary(tool).slice(0, 120) : data.title,
    placeholder: "What was it trying to do? What would have been better?",
    required: true,
    notify,
    save: async (body) => {
      await changeNote({ op: "add", note: tool ? { call: tool.id, name: tool.name, time: clock(tool.t), quote: argSummary(tool).slice(0, 300), body } : { body } });
      notify(`Saved the note in ${notesPath}`);
    },
  });
}

function review(anchor) {
  const text = findingsMarkdown(found, data);
  openNotePopover(anchor, {
    heading: "Review with an agent",
    detail: `${plural(found.length, "finding")}, ${plural(notes.length, "note")}`,
    placeholder: "What do you want out of the review? (optional)",
    notify,
    prompt: async (comment) => {
      const response = await fetch("/api/session-notes/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: dialog.dataset.key, findings: text }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Couldn't build the prompt.");
      return withNote(body.prompt, comment);
    },
  });
}

// Up and Down move between rows; / focuses the filter; N notes the first call of the picked request.
function onKey(event) {
  if (ui.menu) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); return setMenu(false); }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const options = [...dialog.querySelectorAll("[data-s-agent-pick]")];
      const current = options.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : Math.max(0, Math.min(options.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
      options[next]?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Tab") setMenu(false);
    return;
  }
  if (event.target.matches("input, select, textarea")) return;
  if (event.key === "/") { event.preventDefault(); dialog.querySelector("[data-s-find]")?.focus(); return; }
  if (event.key === "n" && !event.metaKey && !event.ctrlKey && ui.pick?.startsWith("r")) {
    const button = dialog.querySelector("[data-s-note]");
    if (button) { event.preventDefault(); addNote(button, data.tools[Number(button.dataset.sNote)]); }
    return;
  }
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
  const rows = [...dialog.querySelectorAll('[data-s="list"] tr[data-s-pick], [data-s="list"] tr[data-s-agent-row]')];
  if (!rows.length) return;
  event.preventDefault();
  const current = rows.findIndex((row) => row.classList.contains("is-picked"));
  const next = rows[Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))];
  if (next.dataset.sAgentRow) { next.focus(); return; }
  ui.pick = next.dataset.sPick;
  if (ui.pick.startsWith("x:")) ui.focus = ui.pick.slice(2);
  renderBody();
  const row = dialog.querySelector('[data-s="list"] .is-picked');
  row?.focus({ preventScroll: true });
  row?.scrollIntoView({ block: "nearest" });
}
