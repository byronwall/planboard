import { escapeHtml, renderMarkdown } from "./markdown.js";
import { showTip, hideTip } from "./code.js";
import { GLYPHS, brandMark } from "./icons.js";
import { modelInfo } from "./chat-threads.js";
import { announceClosed, createOverlay, setOverlayParams } from "./overlay.js";
import { formatDateTime } from "./dates.js";
import { withNote } from "./config.js";
import { openNotePopover } from "./note-popover.js";
import { command, findings, findingsMarkdown, parseArgs, toolFiles } from "./session-findings.js";

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
const modelName = (id) => modelInfo(id)?.name || id || "—";
const home = (text) => String(text ?? "").replace(/\/Users\/[^/\s"]+/g, "~");
const agentName = (index) => index ? data.agents[index].label : "Main agent";
const ACTIONS = { Read: "read", NotebookRead: "read", view_image: "read", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", apply_patch: "edit", Write: "write" };

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
  const first = command(tool) || (args.pattern ?? args.query ?? args.url ?? args.description ?? args.prompt ?? args.message ?? args.code ?? args.task_name);
  if (first !== undefined && first !== "") return home(Array.isArray(first) ? first.join(" ") : String(first)).replace(/\s+/g, " ");
  return home(JSON.stringify(args)).slice(0, 300);
}
const relative = (path) => { const root = data?.cwd ? `${data.cwd.replace(/\/$/, "")}/` : ""; return root && path.startsWith(root) ? path.slice(root.length) : home(path); };

let dialog = null;
let data = null;
let notes = [];
let notesPath = "";
let found = [];
let notify = () => {};
let ui = { tab: "", agent: 0, pick: null, find: "", focus: null };
export const setSessionNotice = (show) => { notify = show; };

export function openSession(key, { tab = "", agent = "", pick = "" } = {}) {
  if (!dialog) build();
  ui = { tab: TABS[tab] ? tab : "", agent: agent === "all" ? -1 : Number(agent) || 0, pick: pick || null, find: "", focus: null };
  dialog.dataset.key = key;
  setOverlayParams({ session: key });
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
  dialog.addEventListener("change", (event) => {
    if (!event.target.matches("[data-s-agent]")) return;
    ui.agent = Number(event.target.value);
    ui.pick = null;
    renderBody();
  });
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
  head.innerHTML = `<span class="session-mark">${brandMark(data.provider === "Claude" ? "claude" : "codex", `chat-app-mark is-${data.provider.toLowerCase()}`)}</span>
    <div class="session-title"><h3>${escapeHtml(data.title)}</h3><p class="code-muted"><span data-tip="${escapeHtml(home(data.path))}">${escapeHtml(data.provider === "Claude" ? "Claude Code" : "Codex")}</span> · ${facts.map((fact, index) => index === 2 ? `<span data-tip="${escapeHtml(home(data.cwd))}">${escapeHtml(fact)}</span>` : escapeHtml(fact)).join(" · ")}</p></div>
    <span class="code-spacer"></span>
    <button type="button" class="code-bar-button" data-s-review data-tip="Save a prompt that asks an agent to explain the findings and your notes, and propose lasting fixes">${glyph("sparkles")}Review with an agent</button>
    <a class="code-bar-button" href="${escapeHtml(data.url)}">${glyph("external-link")}Open in ${data.provider === "Claude" ? "Claude" : "Codex"}</a>${closeButton()}`;
  const agents = data.agents.length > 1 ? `<label class="session-agent">${glyph("bot")}<select data-s-agent aria-label="Agent">${data.agents.map((agent, index) => `<option value="${index}"${ui.agent === index ? " selected" : ""}>${escapeHtml(agentName(index))}</option>`).join("")}<option value="-1"${ui.agent < 0 ? " selected" : ""}>All agents (${data.agents.length})</option></select></label>` : "";
  dialog.querySelector('[data-s="main"]').innerHTML = `<div class="session-stats" data-s="stats"></div>
    <div class="session-chart" data-s="chart"></div>
    <div class="session-toolbar"><div class="code-segment" role="tablist" aria-label="View">${Object.entries(TABS).filter(([key]) => key !== "agents" || data.agents.length > 1).map(([key, label]) => `<button type="button" role="tab" data-s-tab="${key}" aria-pressed="${ui.tab === key}">${label}<span class="code-count" data-s-count="${key}"></span></button>`).join("")}</div>
      ${agents}<label class="code-filter">${glyph("search")}<input type="search" data-s-find placeholder="Find a tool, file or message…" aria-label="Find in this session" spellcheck="false"></label>
      <span class="session-focus" data-s="focus"></span></div>
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
    ...(data.agents.length > 1 && ui.agent < 0 ? [stat("Subagents", exact(data.agents.length - 1))] : []),
    stat("Duration", span(all.duration), "First to last logged event"),
    ...(wait > 1000 ? [stat("Waiting on you", span(wait), "Time between the agent's last step and your next message")] : []),
  ].join("");
  for (const button of dialog.querySelectorAll("[data-s-tab]")) button.setAttribute("aria-pressed", String(button.dataset.sTab === ui.tab));
  const counts = { findings: view.findings.length, timeline: view.requests.length, tools: new Set(view.tools.map((tool) => tool.name)).size, files: fileRows(view.tools).length, agents: data.agents.length, notes: notes.length };
  for (const count of dialog.querySelectorAll("[data-s-count]")) {
    count.textContent = counts[count.dataset.sCount];
    count.classList.toggle("is-alert", count.dataset.sCount === "findings" && view.findings.some((finding) => finding.severity === "problem"));
  }
  if (ui.tab === "findings" && !ui.pick && view.findings[0]) ui.focus = view.findings[0].id;
  const focus = focused();
  dialog.querySelector('[data-s="focus"]').innerHTML = focus && ui.tab !== "findings" ? `<span>${glyph(SEVERITY_ICON[focus.severity])}${escapeHtml(focus.title)}</span><button type="button" class="code-icon-button" data-s-unfocus aria-label="Stop highlighting this finding">${glyph("x")}</button>` : "";
  setOverlayParams({ "session-tab": ui.tab === (found.length ? "findings" : "timeline") ? "" : ui.tab, "session-agent": ui.agent === 0 ? "" : ui.agent < 0 ? "all" : String(ui.agent), "session-pick": ui.pick || "" });
  const list = dialog.querySelector('[data-s="list"]');
  const top = list.scrollTop;
  list.innerHTML = { findings: findingsTable, tools: toolsTable, files: filesTable, agents: agentsTable, notes: notesTable }[ui.tab]?.(view) ?? timelineTable(view);
  list.scrollTop = top;
  dialog.querySelector('[data-s="inspector"]').innerHTML = inspector(view);
  drawChart();
}

// ---------- Chart ----------
// One bar per request in scope, in order: the prompt stacked as cache read, cache write and uncached input, the output
// below the axis on its own scale. A line traces the running total of tokens processed. Dashed rules mark compactions;
// triangles on top mark user messages, labels mark model and effort changes, and a red tick marks a failed call. A
// picked finding lights up its requests and dims the rest.

function drawChart() {
  const host = dialog.querySelector('[data-s="chart"]');
  if (!host) return;
  const { requests, messages, marks } = scope();
  const width = Math.max(320, host.clientWidth);
  const height = 170;
  const pad = { left: 44, right: 50, top: 18, bottom: 20 };
  const outH = 28;
  const inH = height - pad.top - pad.bottom - outH - 8;
  const base = pad.top + inH;
  if (!requests.length) { host.innerHTML = `<p class="code-muted session-note">No model requests in this scope.</p>`; return; }
  const plot = width - pad.left - pad.right;
  const step = plot / requests.length;
  const bar = Math.max(1, Math.min(18, step - (step > 4 ? 1 : 0)));
  const maxIn = Math.max(...requests.map((request) => request.input)) || 1;
  const maxOut = Math.max(...requests.map((request) => request.output)) || 1;
  const window = Math.max(0, ...requests.map((request) => request.window || 0));
  const top = Math.max(maxIn, window && window < maxIn * 1.6 ? window : 0);
  const y = (value) => base - (value / top) * inH;
  const x = (index) => pad.left + index * step + (step - bar) / 2;
  let running = 0;
  const cumulative = requests.map((request) => (running += request.input + request.output));
  const yc = (value) => base - (value / (running || 1)) * inH;
  const at = (t) => { const index = requests.findIndex((request) => request.t >= t); return index < 0 ? requests.length : index; };
  const ticks = [0, 0.5, 1].map((share) => share * top);
  const timeTicks = [...new Set([0, Math.floor(requests.length / 3), Math.floor(2 * requests.length / 3), requests.length - 1])];
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
    const fail = failed.has(request.index) ? `<rect class="session-fail" x="${left}" y="${base + 8 + outH + 2}" width="${Math.max(bar, 2)}" height="3"/>` : "";
    return `<g class="session-bar ${classes}" data-s-pick="r${request.index}"><rect class="session-hit" x="${pad.left + index * step}" y="${pad.top}" width="${Math.max(step, 1)}" height="${height - pad.top - pad.bottom}"/>${stack}<rect class="is-output" x="${left}" y="${base + 6}" width="${bar}" height="${Math.max(out, 0.5)}"/>${fail}</g>`;
  }).join("");
  const line = cumulative.map((value, index) => `${index ? "L" : "M"}${(x(index) + bar / 2).toFixed(1)},${yc(value).toFixed(1)}`).join("");
  const compacts = marks.filter((mark) => mark.kind === "compact").map((mark) => {
    const left = pad.left + at(mark.t) * step - 0.5;
    const tip = `Compacted${mark.trigger ? ` (${mark.trigger})` : ""}${mark.before ? `: ${exact(mark.before)} → ${exact(mark.after || 0)} tokens` : ""} at ${clock(mark.t)}`;
    return `<g class="session-compact" data-tip="${escapeHtml(tip)}"><line x1="${left}" x2="${left}" y1="${pad.top - 4}" y2="${base + 6 + outH}"/><rect x="${left - 5}" y="${pad.top - 6}" width="10" height="${inH + outH}" fill="transparent"/></g>`;
  });
  // A model change and an effort change at the same request share one label.
  const changes = [...Map.groupBy(marks.filter((mark) => mark.kind !== "compact"), (mark) => at(mark.t))].map(([index, group]) => {
    const left = pad.left + index * step - 0.5;
    const label = group.map((mark) => mark.kind === "model" ? modelName(mark.label) : mark.label).join(" · ");
    const tip = group.map((mark) => `${mark.kind === "model" ? "Model" : "Effort"} changed to ${mark.kind === "model" ? modelName(mark.label) : mark.label}`).join("\n") + ` at ${clock(group[0].t)}`;
    return `<g class="session-change" data-tip="${escapeHtml(tip)}"><line x1="${left}" x2="${left}" y1="${pad.top}" y2="${pad.top + 12}"/><text x="${left + 4}" y="${pad.top + 10}">${escapeHtml(label)}</text></g>`;
  });
  const msgSvg = messages.map((message) => {
    const left = pad.left + at(message.t) * step;
    return `<path class="session-msg" d="M${left - 4},${pad.top - 12}h8l-4,6z" data-tip="${escapeHtml(`${clock(message.t)} · ${message.text.slice(0, 160)}`)}" data-s-pick="m${data.messages.indexOf(message)}"/>`;
  }).join("");
  const windowLine = window && window <= top ? `<line class="session-window" x1="${pad.left}" x2="${width - pad.right}" y1="${y(window)}" y2="${y(window)}"/><text class="session-axis" x="${width - pad.right - 4}" y="${y(window) - 3}" text-anchor="end">context window ${num(window)}</text>` : "";
  host.innerHTML = `<svg width="${width}" height="${height}" role="img" aria-label="Tokens per request"${hits.size ? ' class="is-focused"' : ""}>
    ${ticks.map((value) => `<line class="session-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(value)}" y2="${y(value)}"/><text class="session-axis" x="${pad.left - 6}" y="${y(value) + 3}" text-anchor="end">${num(value)}</text>`).join("")}
    <text class="session-axis" x="${pad.left - 6}" y="${base + 6 + outH / 2 + 3}" text-anchor="end">out</text>
    ${windowLine}${bars}<path class="session-cumulative" d="${line}"/>
    <text class="session-axis is-cumulative" x="${width - pad.right + 6}" y="${yc(running) + 3}">${num(running)}</text>
    <text class="session-axis" x="${width - pad.right + 6}" y="${base + 6 + outH / 2 + 3}">${num(maxOut)}</text>
    ${timeTicks.map((index) => `<text class="session-axis" x="${x(index) + bar / 2}" y="${height - 4}" text-anchor="middle">${escapeHtml(clock(requests[index].t))}</text>`).join("")}
    ${compacts.join("")}${changes.join("")}${msgSvg}</svg>
    <div class="session-legend"><span class="is-cached">Cache read</span><span class="is-write">Cache write</span><span class="is-fresh">Uncached input</span><span class="is-output">Output</span><span class="is-cumulative">Running total</span><span class="is-compact">Compaction</span><span class="is-msg">Your message</span><span class="is-fail">Failed call</span></div>`;
  for (const group of host.querySelectorAll(".session-bar")) {
    const index = Number(group.dataset.sPick.slice(1));
    const request = data.requests[index];
    const said = request.text ? `\n${request.text.split("\n")[0].slice(0, 120)}` : "";
    group.dataset.tip = `#${requests.findIndex((item) => item.index === index) + 1} · ${clock(request.t)} · ${modelName(request.model)}\nInput ${exact(request.input)} (${pct(request.cached, request.input)} cache read, ${exact(request.cacheWrite)} written)\nOutput ${exact(request.output)}${request.reasoning ? ` (${exact(request.reasoning)} reasoning)` : ""}${said}`;
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
  const width = showAgent ? 8 : 7;
  const rows = [
    ...messages.map((message, turn) => {
      const index = data.messages.indexOf(message);
      if (!matches(message.text)) return { t: message.t, order: 0, html: "" };
      const stats = turnStats(message, messages, requests, tools);
      const facts = [plural(stats.requests.length, "request"), plural(stats.calls.length, "call"), stats.failed && `<em>${stats.failed} failed</em>`, span(stats.ms), stats.cost !== null && usd(stats.cost)].filter(Boolean).join(" · ");
      return { t: message.t, order: 0, html: `<tr class="code-row session-msg-row${ui.pick === `m${index}` ? " is-picked" : ""}" data-s-pick="m${index}" tabindex="0"><td class="session-num">${glyph("message-square")}</td><td class="session-time">${clock(message.t)}</td><td colspan="${width - 2}"><span class="session-turn">Turn ${turn + 1} · ${facts}</span><span class="session-msg-text">${escapeHtml(message.text)}</span></td></tr>` };
    }),
    ...marks.map((mark) => ({ t: mark.t, order: 1, html: `<tr class="session-mark-row is-${mark.kind}"><td class="session-num">${glyph(mark.kind === "compact" ? "layers" : "settings")}</td><td class="session-time">${clock(mark.t)}</td><td colspan="${width - 2}">${mark.kind === "compact" ? `Context compacted${mark.trigger ? ` (${escapeHtml(mark.trigger)})` : ""}${mark.before ? `: ${exact(mark.before)} → ${exact(mark.after || 0)} tokens` : ""}` : `${mark.kind === "model" ? "Model" : "Effort"} changed to <b>${escapeHtml(mark.kind === "model" ? modelName(mark.label) : mark.label)}</b>`}</td></tr>` })),
    ...requests.map((request, position) => {
      const own = byRequest.get(request.index) || [];
      if (!matches(request.model, request.text, ...own.flatMap((tool) => [tool.name, tool.args]))) return { t: request.t, order: 2, html: "" };
      const names = [...Map.groupBy(own, (tool) => tool.name)].map(([name, calls]) => {
        const failed = calls.filter((tool) => tool.error).length;
        return `<span class="session-chip${failed ? " is-error" : ""}">${escapeHtml(name)}${calls.length > 1 ? `<i>×${calls.length}</i>` : ""}${failed ? glyph("triangle-alert") : ""}</span>`;
      }).join("");
      const pinned = own.some((tool) => noted(tool).length) ? `<span class="session-chip is-note" data-tip="You left a note here">${glyph("pen-line")}</span>` : "";
      const fresh = request.input - request.cached;
      return { t: request.t, order: 2, html: `<tr class="code-row session-req${ui.pick === `r${request.index}` ? " is-picked" : ""}${hits.has(request.index) ? " is-hit" : ""}" data-s-pick="r${request.index}" tabindex="0">
        <td class="session-num">${position + 1}</td><td class="session-time" data-tip="${escapeHtml(`${new Date(request.t).toLocaleString()} · ${modelName(request.model)}${request.effort ? ` · ${request.effort}` : ""}`)}">${clock(request.t)}</td>
        ${showAgent ? `<td class="session-agent-cell">${escapeHtml(request.agent ? data.agents[request.agent].label : "Main")}</td>` : ""}
        <td class="session-step">${request.text ? `<span class="session-said">${escapeHtml(request.text.replace(/\s+/g, " "))}</span>` : ""}<span class="session-tools">${names}${pinned}</span></td>
        <td class="session-n">${num(request.input)}</td>
        <td class="session-n${request.input && request.cached / request.input < 0.5 ? " is-warn" : ""}">${pct(request.cached, request.input)}</td>
        <td class="session-n" data-tip="${exact(fresh)} tokens not read from cache">${num(fresh)}</td>
        <td class="session-n">${num(request.output)}</td></tr>` };
    }),
  ].sort((a, b) => a.t - b.t || a.order - b.order).map((row) => row.html).join("");
  return `<table class="code-table session-table"><thead><tr><th class="session-num">#</th><th>Time</th>${showAgent ? "<th>Agent</th>" : ""}<th>What the agent said and did</th><th class="session-n" data-tip="Prompt tokens: the context this request read">Context</th><th class="session-n" data-tip="Share of the prompt read from cache">Cache</th><th class="session-n" data-tip="Prompt tokens not read from cache">New</th><th class="session-n">Output</th></tr></thead><tbody>${rows || `<tr><td colspan="${width}" class="session-note">Nothing matches.</td></tr>`}</tbody></table>`;
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
  if (shell) return `${fence(shell, "bash")}${args?.description ? `<p class="session-label">${escapeHtml(args.description)}</p>` : ""}`;
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
function callRows(calls, { name = true } = {}) {
  return `<table class="session-calls"><tbody>${calls.map((tool) => `<tr class="code-row${tool.error ? " is-error" : ""}" data-s-goto="${tool.request}" data-s-call="${data.tools.indexOf(tool)}" tabindex="0" data-tip="Show this call in the timeline"><td class="session-time">${clock(tool.t)}</td>${name ? `<td>${escapeHtml(tool.name)}</td>` : ""}<td class="session-args">${escapeHtml(argSummary(tool))}</td><td class="session-n">${span(tool.dur)}</td><td class="session-n">${tool.error ? glyph("triangle-alert") : noted(tool).length ? glyph("pen-line") : ""}</td></tr>`).join("")}</tbody></table>`;
}

function inspector(view) {
  const first = { findings: view.findings[0] && `x:${view.findings[0].id}`, tools: toolStats(view.tools)[0] && `t:${toolStats(view.tools)[0].name}`,
    files: fileRows(view.tools)[0] && `f:${fileRows(view.tools)[0].path}`, notes: notes[0] && `n:${notes[0].id}` }[ui.tab];
  const pick = ui.pick || first || (view.requests[0] ? `r${view.requests[0].index}` : "");
  if (pick.startsWith("x:")) {
    const finding = found.find((item) => item.id === pick.slice(2));
    if (!finding) return "";
    const calls = finding.calls.map((index) => data.tools[index]);
    const requests = finding.calls.length ? [] : finding.requests.map((index) => data.requests[index]);
    return `<h4>${glyph(SEVERITY_ICON[finding.severity], `code-icon is-${finding.severity}`)}${escapeHtml(finding.title)}</h4>
      <p>${escapeHtml(home(finding.detail))}</p>
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
  if (event.target.closest("[data-s-review]")) return review(event.target.closest("[data-s-review]"));
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
