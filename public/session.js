import { escapeHtml, renderMarkdown as renderMarkdownSource } from "./markdown.js";
import { showTip, hideTip } from "./code.js";
import { GLYPHS, brandMark } from "./icons.js";
import { modelInfo } from "./chat-threads.js";
import { announceClosed, createOverlay, setOverlayParams } from "./overlay.js";
import { formatDateTime } from "./dates.js";

// One agent chat session read in full (`?session=claude:<id>` or `codex:<id>`): a line of totals, a chart of every model
// request's context and output, and four tables beside an inspector: the timeline of requests and messages, tool calls
// by tool, files the tools touched, and the agents. Data comes from /api/chat-session (agent-session.ts).

const TABS = { timeline: "Timeline", tools: "Tools", files: "Files", agents: "Agents" };
const glyph = (name, className = "code-icon") => `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${GLYPHS[name]}</svg>`;
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const num = (value) => value ? compact.format(value) : "0";
const exact = (value) => Math.round(value).toLocaleString();
const usd = (value) => value === null || value === undefined ? "—" : value < 0.01 ? "<$0.01" : `$${value.toFixed(value < 10 ? 2 : 1)}`;
const pct = (part, whole) => whole ? `${Math.round(100 * part / whole)}%` : "—";
export function span(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${String(Math.round(ms % 60_000 / 1000)).padStart(2, "0")}s`;
  return `${Math.floor(ms / 3_600_000)}h ${String(Math.round(ms % 3_600_000 / 60_000)).padStart(2, "0")}m`;
}
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const modelName = (id) => modelInfo(id)?.name || id || "—";
const home = (text) => text.replace(/\/Users\/[^/\s"]+/g, "~");

// Paths a tool call read or changed, from its arguments: Claude's file_path/path/notebook_path, Codex's apply_patch headers.
export function toolFiles(tool) {
  let args;
  try { args = JSON.parse(tool.args); } catch { args = null; }
  if (args && typeof args === "object") {
    const path = args.file_path || args.notebook_path || (/^(?:Grep|Glob|LS)$/.test(tool.name) ? "" : args.path);
    if (typeof path === "string" && path) return [path];
    const patch = typeof args.input === "string" ? args.input : typeof args.patch === "string" ? args.patch : "";
    if (patch.includes("*** Begin Patch")) return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1].trim());
  }
  return [];
}
const ACTIONS = { Read: "read", NotebookRead: "read", view_image: "read", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", apply_patch: "edit", Write: "write" };

// The first meaningful line of a call's arguments: the command, the path, the pattern, else compact JSON.
function argSummary(tool) {
  let args;
  try { args = JSON.parse(tool.args); } catch { return home(tool.args.split("\n").find((line) => line.trim()) || ""); }
  if (!args || typeof args !== "object") return home(String(args ?? ""));
  const files = toolFiles(tool);
  if (files.length) return home(files.join(", "));
  const first = args.command ?? args.cmd ?? args.pattern ?? args.query ?? args.url ?? args.description ?? args.prompt ?? args.message ?? args.code ?? args.task_name;
  if (first !== undefined) return home(Array.isArray(first) ? first.join(" ") : String(first)).replace(/\s+/g, " ");
  return home(JSON.stringify(args)).slice(0, 300);
}

let dialog = null;
let data = null;
let ui = { tab: "timeline", agent: 0, pick: null, find: "" };

export function openSession(key, { tab = "", agent = "", pick = "" } = {}) {
  if (!dialog) build();
  ui = { tab: TABS[tab] ? tab : "timeline", agent: agent === "all" ? -1 : Number(agent) || 0, pick: pick || null, find: "" };
  dialog.dataset.key = key;
  setOverlayParams({ session: key });
  dialog.querySelector('[data-s="head"]').innerHTML = `<div class="session-title"><h3>Loading session…</h3></div><span class="code-spacer"></span>${closeButton()}`;
  dialog.querySelector('[data-s="main"]').innerHTML = `<p class="code-muted session-note">Reading the log…</p>`;
  dialog.dataset.sessionState = "loading";
  if (!dialog.open) { dialog.showModal(); dialog.focus({ preventScroll: true }); }
  fetch(`/api/chat-session?key=${encodeURIComponent(key)}`).then(async (response) => {
    const body = await response.json();
    if (dialog.dataset.key !== key) return;
    if (!response.ok) throw new Error(body.error || "Could not read this session.");
    data = body;
    if (ui.agent >= data.agents.length) ui.agent = 0;
    render();
    dialog.dataset.sessionState = "ready";
  }).catch((error) => {
    if (dialog.dataset.key !== key) return;
    dialog.querySelector('[data-s="head"]').innerHTML = `<div class="session-title"><h3>Session not found</h3><p class="code-muted">${escapeHtml(key)}</p></div><span class="code-spacer"></span>${closeButton()}`;
    dialog.querySelector('[data-s="main"]').innerHTML = `<p class="session-note">${escapeHtml(error.message)} Planboard reads Claude Code and Codex logs from this computer's ~/.claude and ~/.codex folders.</p>`;
    dialog.dataset.sessionState = "error";
  });
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
  return { requests, tools, messages: data.messages.filter(inScope), marks: data.marks.filter(inScope) };
}
function totals({ requests, tools, messages, marks }) {
  const sum = (key) => requests.reduce((total, request) => total + (request[key] || 0), 0);
  const costs = requests.map((request) => request.cost).filter((cost) => cost !== null && cost !== undefined);
  const agents = ui.agent < 0 ? data.agents : [data.agents[ui.agent]];
  const start = Math.min(...agents.map((agent) => agent.start).filter(Boolean));
  const end = Math.max(...agents.map((agent) => agent.end).filter(Boolean));
  return { input: sum("input"), cached: sum("cached"), write: sum("cacheWrite"), output: sum("output"), reasoning: sum("reasoning"),
    cost: ui.agent < 0 && data.costExact ? data.cost : costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    exactCost: ui.agent < 0 && data.costExact, priced: costs.length, requests: requests.length, peak: Math.max(0, ...requests.map((request) => request.input)),
    tools: tools.length, errors: tools.filter((tool) => tool.error).length, messages: messages.length,
    compactions: marks.filter((mark) => mark.kind === "compact").length, duration: end - start };
}

// ---------- Render ----------

function render() {
  const head = dialog.querySelector('[data-s="head"]');
  const models = [...new Set(data.requests.filter((request) => request.agent === 0).map((request) => request.model))];
  const efforts = [...new Set(data.requests.filter((request) => request.agent === 0).map((request) => request.effort).filter(Boolean))];
  const folder = data.cwd.split("/").filter(Boolean).at(-1) || "";
  const facts = [models.map(modelName).join(" → "), efforts.join(" → "), folder, data.branch, data.start && formatDateTime(new Date(data.start))].filter(Boolean);
  head.innerHTML = `<span class="session-mark">${brandMark(data.provider === "Claude" ? "claude" : "codex", `chat-app-mark is-${data.provider.toLowerCase()}`)}</span>
    <div class="session-title"><h3>${escapeHtml(data.title)}</h3><p class="code-muted"><span data-tip="${escapeHtml(data.path)}">${escapeHtml(data.provider === "Claude" ? "Claude Code" : "Codex")}</span> · ${facts.map((fact, index) => index === 2 ? `<span data-tip="${escapeHtml(data.cwd)}">${escapeHtml(fact)}</span>` : escapeHtml(fact)).join(" · ")}</p></div>
    <span class="code-spacer"></span><a class="code-bar-button" href="${escapeHtml(data.url)}">${glyph("external-link")}Open in ${data.provider === "Claude" ? "Claude" : "Codex"}</a>${closeButton()}`;
  const agents = data.agents.length > 1 ? `<label class="session-agent">${glyph("bot")}<select data-s-agent aria-label="Agent">${data.agents.map((agent, index) => `<option value="${index}"${ui.agent === index ? " selected" : ""}>${escapeHtml(index ? agent.label : "Main agent")}</option>`).join("")}<option value="-1"${ui.agent < 0 ? " selected" : ""}>All agents (${data.agents.length})</option></select></label>` : "";
  dialog.querySelector('[data-s="main"]').innerHTML = `<div class="session-stats" data-s="stats"></div>
    <div class="session-chart" data-s="chart"></div>
    <div class="session-toolbar"><div class="code-segment" role="tablist" aria-label="View">${Object.entries(TABS).filter(([key]) => key !== "agents" || data.agents.length > 1).map(([key, label]) => `<button type="button" role="tab" data-s-tab="${key}" aria-pressed="${ui.tab === key}">${label}<span class="code-count" data-s-count="${key}"></span></button>`).join("")}</div>
      ${agents}<label class="code-filter">${glyph("search")}<input type="search" data-s-find placeholder="Find a tool, file or message…" aria-label="Find in this session" spellcheck="false"></label></div>
    <div class="session-split"><div class="session-list" data-s="list"></div><aside class="session-inspector" data-s="inspector" aria-label="Details"></aside></div>`;
  renderBody();
}

function renderBody() {
  const view = scope();
  const all = totals(view);
  const stat = (label, value, tip = "", tone = "") => `<span class="session-stat${tone ? ` is-${tone}` : ""}"${tip ? ` data-tip="${escapeHtml(tip)}"` : ""}><small>${label}</small><b>${value}</b></span>`;
  dialog.querySelector('[data-s="stats"]').innerHTML = [
    stat("Requests", exact(all.requests)),
    stat("Input", num(all.input), `${exact(all.input)} prompt tokens across every request`),
    stat("Cache read", pct(all.cached, all.input), `${exact(all.cached)} tokens read from the prompt cache`),
    ...(all.write ? [stat("Cache write", num(all.write), `${exact(all.write)} tokens written to the prompt cache`)] : []),
    stat("Uncached", num(all.input - all.cached - all.write), `${exact(all.input - all.cached - all.write)} input tokens neither read from nor written to the cache`),
    stat("Output", num(all.output), `${exact(all.output)} output tokens, ${exact(all.reasoning)} of them reasoning`),
    stat("Peak context", num(all.peak), `The largest single prompt: ${exact(all.peak)} tokens`),
    stat("Cost", usd(all.cost), all.exactCost ? "Claude Code's own total for this session" : all.priced ? `Estimated from public API prices for ${all.priced} of ${all.requests} requests` : "No price is known for this model", all.cost !== null && !all.exactCost ? "estimate" : ""),
    stat("Tool calls", `${exact(all.tools)}${all.errors ? ` <em>${all.errors} failed</em>` : ""}`),
    stat("Messages", exact(all.messages), "Messages the user typed"),
    stat("Compactions", exact(all.compactions)),
    ...(data.agents.length > 1 && ui.agent < 0 ? [stat("Subagents", exact(data.agents.length - 1))] : []),
    stat("Duration", span(all.duration), "First to last logged event"),
  ].join("");
  for (const button of dialog.querySelectorAll("[data-s-tab]")) button.setAttribute("aria-pressed", String(button.dataset.sTab === ui.tab));
  const counts = { timeline: view.requests.length, tools: new Set(view.tools.map((tool) => tool.name)).size, files: fileRows(view.tools).length, agents: data.agents.length };
  for (const count of dialog.querySelectorAll("[data-s-count]")) count.textContent = counts[count.dataset.sCount];
  setOverlayParams({ "session-tab": ui.tab === "timeline" ? "" : ui.tab, "session-agent": ui.agent === 0 ? "" : ui.agent < 0 ? "all" : String(ui.agent), "session-pick": ui.pick || "" });
  const list = dialog.querySelector('[data-s="list"]');
  const top = list.scrollTop;
  list.innerHTML = ui.tab === "tools" ? toolsTable(view) : ui.tab === "files" ? filesTable(view) : ui.tab === "agents" ? agentsTable() : timelineTable(view);
  list.scrollTop = top;
  dialog.querySelector('[data-s="inspector"]').innerHTML = inspector(view);
  drawChart();
}

// ---------- Chart ----------
// One bar per request in scope, in order: the prompt stacked as cache read, cache write and uncached input, the output
// below the axis on its own scale. A line traces the running total of tokens processed. Dashed rules mark compactions;
// triangles on top mark user messages, and labels mark model and effort changes.

function drawChart() {
  const host = dialog.querySelector('[data-s="chart"]');
  if (!host) return;
  const { requests, messages, marks } = scope();
  const width = Math.max(320, host.clientWidth);
  const height = 190;
  const pad = { left: 44, right: 50, top: 18, bottom: 22 };
  const outH = 34;
  const inH = height - pad.top - pad.bottom - outH - 6;
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
    const agentClass = ui.agent < 0 && request.agent ? " is-sub" : "";
    return `<g class="session-bar${request.index === picked ? " is-picked" : ""}${agentClass}" data-s-pick="r${request.index}"><rect class="session-hit" x="${pad.left + index * step}" y="${pad.top}" width="${Math.max(step, 1)}" height="${height - pad.top - pad.bottom}"/>${stack}<rect class="is-output" x="${left}" y="${base + 6}" width="${bar}" height="${Math.max(out, 0.5)}"/></g>`;
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
  const marksSvg = [...compacts, ...changes].join("");
  const msgSvg = messages.map((message) => {
    const left = pad.left + at(message.t) * step;
    return `<path class="session-msg" d="M${left - 4},${pad.top - 12}h8l-4,6z" data-tip="${escapeHtml(`${clock(message.t)} · ${message.text.slice(0, 160)}`)}" data-s-pick="m${data.messages.indexOf(message)}"/>`;
  }).join("");
  const windowLine = window && window <= top ? `<line class="session-window" x1="${pad.left}" x2="${width - pad.right}" y1="${y(window)}" y2="${y(window)}"/><text class="session-axis" x="${width - pad.right - 4}" y="${y(window) - 3}" text-anchor="end">context window ${num(window)}</text>` : "";
  host.innerHTML = `<svg width="${width}" height="${height}" role="img" aria-label="Tokens per request">
    ${ticks.map((value) => `<line class="session-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(value)}" y2="${y(value)}"/><text class="session-axis" x="${pad.left - 6}" y="${y(value) + 3}" text-anchor="end">${num(value)}</text>`).join("")}
    <text class="session-axis" x="${pad.left - 6}" y="${base + 6 + outH / 2 + 3}" text-anchor="end">out</text>
    ${windowLine}${bars}<path class="session-cumulative" d="${line}"/>
    <text class="session-axis is-cumulative" x="${width - pad.right + 6}" y="${yc(running) + 3}">${num(running)}</text>
    <text class="session-axis" x="${width - pad.right + 6}" y="${base + 6 + outH / 2 + 3}">${num(maxOut)}</text>
    ${timeTicks.map((index) => `<text class="session-axis" x="${x(index) + bar / 2}" y="${height - 6}" text-anchor="middle">${escapeHtml(clock(requests[index].t))}</text>`).join("")}
    ${marksSvg}${msgSvg}</svg>
    <div class="session-legend"><span class="is-cached">Cache read</span><span class="is-write">Cache write</span><span class="is-fresh">Uncached input</span><span class="is-output">Output</span><span class="is-cumulative">Running total</span><span class="is-compact">Compaction</span><span class="is-msg">User message</span></div>`;
  for (const group of host.querySelectorAll(".session-bar")) {
    const request = data.requests[Number(group.dataset.sPick.slice(1))];
    group.dataset.tip = `#${requests.findIndex((item) => item.index === Number(group.dataset.sPick.slice(1))) + 1} · ${clock(request.t)} · ${modelName(request.model)}\nInput ${exact(request.input)} (${pct(request.cached, request.input)} cache read, ${exact(request.cacheWrite)} written)\nOutput ${exact(request.output)}${request.reasoning ? ` (${exact(request.reasoning)} reasoning)` : ""}`;
  }
}

// ---------- Tables ----------

function matches(...values) {
  const query = ui.find.trim().toLowerCase();
  return !query || values.some((value) => String(value ?? "").toLowerCase().includes(query));
}

function timelineTable({ requests, tools, messages, marks }) {
  const byRequest = Map.groupBy(tools, (tool) => tool.request);
  const showAgent = ui.agent < 0;
  const rows = [
    ...messages.map((message) => ({ t: message.t, order: 0, html: matches(message.text) ? `<tr class="code-row session-msg-row${ui.pick === `m${data.messages.indexOf(message)}` ? " is-picked" : ""}" data-s-pick="m${data.messages.indexOf(message)}" tabindex="0"><td class="session-num">${glyph("message-square")}</td><td class="session-time">${clock(message.t)}</td><td colspan="${showAgent ? 7 : 6}"><span class="session-msg-text">${escapeHtml(message.text)}</span></td></tr>` : "" })),
    ...marks.map((mark) => ({ t: mark.t, order: 1, html: `<tr class="session-mark-row is-${mark.kind}"><td class="session-num">${glyph(mark.kind === "compact" ? "layers" : "settings")}</td><td class="session-time">${clock(mark.t)}</td><td colspan="${showAgent ? 7 : 6}">${mark.kind === "compact" ? `Context compacted${mark.trigger ? ` (${escapeHtml(mark.trigger)})` : ""}${mark.before ? `: ${exact(mark.before)} → ${exact(mark.after || 0)} tokens` : ""}` : `${mark.kind === "model" ? "Model" : "Effort"} changed to <b>${escapeHtml(mark.kind === "model" ? modelName(mark.label) : mark.label)}</b>`}</td></tr>` })),
    ...requests.map((request, position) => {
      const own = byRequest.get(request.index) || [];
      if (!matches(request.model, ...own.flatMap((tool) => [tool.name, tool.args]))) return { t: request.t, order: 2, html: "" };
      const names = [...Map.groupBy(own, (tool) => tool.name)].map(([name, calls]) => {
        const failed = calls.filter((tool) => tool.error).length;
        return `<span class="session-chip${failed ? " is-error" : ""}">${escapeHtml(name)}${calls.length > 1 ? `<i>×${calls.length}</i>` : ""}${failed ? glyph("triangle-alert") : ""}</span>`;
      }).join("");
      const fresh = request.input - request.cached;
      return { t: request.t, order: 2, html: `<tr class="code-row session-req${ui.pick === `r${request.index}` ? " is-picked" : ""}" data-s-pick="r${request.index}" tabindex="0">
        <td class="session-num">${position + 1}</td><td class="session-time" data-tip="${escapeHtml(new Date(request.t).toLocaleString())}">${clock(request.t)}</td>
        ${showAgent ? `<td class="session-agent-cell">${escapeHtml(request.agent ? data.agents[request.agent].label : "Main")}</td>` : ""}
        <td class="session-model">${escapeHtml(modelName(request.model))}${request.effort ? ` <small>${escapeHtml(request.effort)}</small>` : ""}</td>
        <td class="session-n">${num(request.input)}</td>
        <td class="session-n${request.input && request.cached / request.input < 0.5 ? " is-warn" : ""}">${pct(request.cached, request.input)}</td>
        <td class="session-n" data-tip="${exact(fresh)} tokens not read from cache">${num(fresh)}</td>
        <td class="session-n">${num(request.output)}</td>
        <td class="session-tools">${names}</td></tr>` };
    }),
  ].sort((a, b) => a.t - b.t || a.order - b.order).map((row) => row.html).join("");
  return `<table class="code-table session-table"><thead><tr><th class="session-num">#</th><th>Time</th>${showAgent ? "<th>Agent</th>" : ""}<th>Model</th><th class="session-n" data-tip="Prompt tokens: the context this request read">Context</th><th class="session-n" data-tip="Share of the prompt read from cache">Cache</th><th class="session-n" data-tip="Prompt tokens not read from cache">New</th><th class="session-n">Output</th><th>Tool calls</th></tr></thead><tbody>${rows || `<tr><td colspan="9" class="session-note">Nothing matches.</td></tr>`}</tbody></table>`;
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
  return `<table class="code-table session-table"><thead><tr><th>Tool</th><th class="session-n">Calls</th><th class="session-n">Failed</th><th class="session-n" data-tip="Time from the call to its result, summed">Total time</th><th class="session-n">Median</th><th class="session-n">Longest</th><th class="session-n" data-tip="Characters of results returned to the model">Results</th></tr></thead><tbody>${stats.map((row) => `<tr class="code-row${ui.pick === `t:${row.name}` ? " is-picked" : ""}" data-s-pick="t:${escapeHtml(row.name)}" tabindex="0">
    <td class="session-tool-name">${escapeHtml(row.name)}</td>
    <td class="session-n">${row.calls.length}</td>
    <td class="session-n${row.errors ? " is-error" : ""}">${row.errors || ""}</td>
    <td class="session-n">${span(row.time)}</td><td class="session-n">${span(row.median)}</td><td class="session-n">${span(row.max)}</td>
    <td class="session-n" data-tip="${exact(row.size)} characters">${num(row.size)}</td></tr>`).join("") || `<tr><td colspan="7" class="session-note">No tool calls.</td></tr>`}</tbody></table>`;
}

function fileRows(tools) {
  const files = new Map();
  for (const tool of tools) {
    for (const path of toolFiles(tool)) {
      const row = files.get(path) || { path, read: 0, edit: 0, write: 0, other: 0, calls: [], last: 0 };
      row[ACTIONS[tool.name] || "other"]++;
      row.calls.push(tool);
      row.last = Math.max(row.last, tool.t);
      files.set(path, row);
    }
  }
  return [...files.values()].sort((a, b) => b.calls.length - a.calls.length || a.path.localeCompare(b.path));
}

function filesTable({ tools }) {
  const rows = fileRows(tools).filter((row) => matches(row.path));
  const root = data.cwd ? `${data.cwd.replace(/\/$/, "")}/` : "";
  const cell = (value) => `<td class="session-n">${value || ""}</td>`;
  return `<table class="code-table session-table"><thead><tr><th>File</th><th class="session-n">Reads</th><th class="session-n">Edits</th><th class="session-n">Writes</th><th class="session-n" data-tip="Searches and other tools that named this path">Other</th><th>Last</th></tr></thead><tbody>${rows.map((row) => `<tr class="code-row${ui.pick === `f:${row.path}` ? " is-picked" : ""}" data-s-pick="f:${escapeHtml(row.path)}" tabindex="0">
    <td class="session-path" data-tip="${escapeHtml(row.path)}">${escapeHtml(row.path.startsWith(root) ? row.path.slice(root.length) : home(row.path))}</td>${cell(row.read)}${cell(row.edit)}${cell(row.write)}${cell(row.other)}<td class="session-time">${clock(row.last)}</td></tr>`).join("") || `<tr><td colspan="6" class="session-note">No tool call named a file.</td></tr>`}</tbody></table>`;
}

function agentsTable() {
  return `<table class="code-table session-table"><thead><tr><th>Agent</th><th>Model</th><th class="session-n">Requests</th><th class="session-n">Input</th><th class="session-n">Output</th><th class="session-n">Tool calls</th><th class="session-n">Started</th><th class="session-n">Duration</th></tr></thead><tbody>${data.agents.map((agent, index) => {
    const requests = data.requests.filter((request) => request.agent === index);
    const tools = data.tools.filter((tool) => tool.agent === index);
    const errors = tools.filter((tool) => tool.error).length;
    if (!matches(agent.label, agent.type, agent.description)) return "";
    return `<tr class="code-row${ui.agent === index ? " is-picked" : ""}" data-s-agent-row="${index}" tabindex="0">
      <td>${index ? glyph("bot") : ""}<b>${escapeHtml(index ? agent.label : "Main agent")}</b>${agent.type && agent.type !== agent.label ? ` <small class="code-muted">${escapeHtml(agent.type)}</small>` : ""}</td>
      <td class="session-model">${escapeHtml(modelName(agent.model))}</td><td class="session-n">${requests.length}</td>
      <td class="session-n">${num(requests.reduce((sum, request) => sum + request.input, 0))}</td><td class="session-n">${num(requests.reduce((sum, request) => sum + request.output, 0))}</td>
      <td class="session-n">${tools.length}${errors ? ` <em class="is-error">${errors} failed</em>` : ""}</td><td class="session-n">${agent.start ? clock(agent.start) : "—"}</td><td class="session-n">${span(agent.end - agent.start)}</td></tr>`;
  }).join("")}</tbody></table>`;
}

// ---------- Inspector ----------

function code(text) {
  return `<pre class="session-code">${escapeHtml(home(text))}</pre>`;
}
function prettyArgs(args) {
  try { const value = JSON.parse(args); return typeof value === "object" && value ? JSON.stringify(value, null, 2) : String(value); } catch { return args; }
}
function toolBlock(tool) {
  const spawn = tool.spawns !== undefined ? `<button type="button" class="code-bar-button" data-s-agent-row="${tool.spawns}">${glyph("bot")}Open subagent: ${escapeHtml(data.agents[tool.spawns].label)}</button>` : "";
  return `<section class="session-call${tool.error ? " is-error" : ""}"><header><b>${escapeHtml(tool.name)}</b>${tool.via ? ` <small>in ${escapeHtml(tool.via)}</small>` : ""}${tool.error ? `<span class="session-failed">${glyph("triangle-alert")}Failed</span>` : ""}<span class="code-spacer"></span><small>${clock(tool.t)} · ${span(tool.dur)} · ${num(tool.size)} chars</small></header>
    ${code(prettyArgs(tool.args))}${spawn}${tool.result ? `<p class="session-label">Result${tool.size > tool.result.length ? ` <small>(first ${exact(tool.result.length)} of ${exact(tool.size)} characters)</small>` : ""}</p>${code(tool.result)}` : `<p class="session-label code-muted">No result logged.</p>`}</section>`;
}

function inspector(view) {
  const pick = ui.pick || (view.requests[0] ? `r${view.requests[0].index}` : "");
  if (pick.startsWith("r")) {
    const index = Number(pick.slice(1));
    const request = data.requests[index];
    if (!request) return "";
    const tools = data.tools.filter((tool) => tool.request === index);
    const fresh = request.input - request.cached - request.cacheWrite;
    const facts = [
      ["Time", `${new Date(request.t).toLocaleString()}`], ["Agent", request.agent ? data.agents[request.agent].label : "Main agent"],
      ["Model", `${modelName(request.model)}${request.effort ? ` · ${request.effort} effort` : ""}`],
      ["Input", `${exact(request.input)} = ${exact(request.cached)} cache read + ${exact(request.cacheWrite)} cache write + ${exact(fresh)} uncached`],
      ["Output", `${exact(request.output)}${request.reasoning ? ` (${exact(request.reasoning)} reasoning)` : ""}`],
      ...(request.window ? [["Context", `${pct(request.input, request.window)} of ${exact(request.window)}`]] : []),
      ...(request.thinkingMs ? [["Thinking", span(request.thinkingMs)]] : []),
      ...(request.stop ? [["Stop", request.stop.replaceAll("_", " ")]] : []),
      ["Cost", `${usd(request.cost)}${request.cost !== null ? " (estimate)" : ""}`],
    ];
    return `<h4>Request ${view.requests.findIndex((item) => item.index === index) + 1}</h4><dl class="session-facts">${facts.map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>
      <p class="session-label">${tools.length ? `${tools.length} tool call${tools.length === 1 ? "" : "s"}` : "No tool calls"}</p>${tools.map(toolBlock).join("")}`;
  }
  if (pick.startsWith("m")) {
    const message = data.messages[Number(pick.slice(1))];
    return message ? `<h4>User message</h4><p class="code-muted">${new Date(message.t).toLocaleString()}</p><div class="session-message markdown">${renderMarkdownSource(message.text, "")}</div>` : "";
  }
  if (pick.startsWith("t:") || pick.startsWith("f:")) {
    const key = pick.slice(2);
    const calls = pick.startsWith("t:") ? view.tools.filter((tool) => tool.name === key) : view.tools.filter((tool) => toolFiles(tool).includes(key));
    return `<h4>${escapeHtml(pick.startsWith("t:") ? key : home(key))}</h4><p class="code-muted">${calls.length} call${calls.length === 1 ? "" : "s"}${calls.some((tool) => tool.error) ? ` · ${calls.filter((tool) => tool.error).length} failed` : ""}</p>
      <table class="session-calls"><tbody>${calls.map((tool) => `<tr class="code-row${tool.error ? " is-error" : ""}" data-s-goto="${tool.request}" tabindex="0" data-tip="Show request in the timeline"><td class="session-time">${clock(tool.t)}</td>${pick.startsWith("f:") ? `<td>${escapeHtml(tool.name)}</td>` : ""}<td class="session-args">${escapeHtml(argSummary(tool))}</td><td class="session-n">${span(tool.dur)}</td><td class="session-n">${tool.error ? glyph("triangle-alert") : ""}</td></tr>`).join("")}</tbody></table>`;
  }
  return "";
}

// ---------- Events ----------

function onClick(event) {
  if (event.target === dialog) return;
  if (event.target.closest("[data-s-close]")) return dialog.close();
  const tab = event.target.closest("[data-s-tab]");
  if (tab) { ui.tab = tab.dataset.sTab; ui.pick = null; return renderBody(); }
  const agentRow = event.target.closest("[data-s-agent-row]");
  if (agentRow) { ui.agent = Number(agentRow.dataset.sAgentRow); ui.tab = "timeline"; ui.pick = null; return render(); }
  const goto = event.target.closest("[data-s-goto]");
  if (goto) { ui.tab = "timeline"; ui.pick = `r${goto.dataset.sGoto}`; renderBody(); return reveal(); }
  const pick = event.target.closest("[data-s-pick]");
  if (pick) {
    ui.pick = pick.dataset.sPick;
    if (pick.closest('[data-s="chart"]')) { ui.tab = "timeline"; renderBody(); return reveal(); }
    renderBody();
  }
}

function reveal() {
  dialog.querySelector('[data-s="list"] .is-picked')?.scrollIntoView({ block: "nearest" });
}

// Up and Down move between rows; Enter on a row picks it; / focuses the filter.
function onKey(event) {
  if (event.key === "/" && !event.target.matches("input, select, textarea")) { event.preventDefault(); dialog.querySelector("[data-s-find]")?.focus(); return; }
  if (!["ArrowDown", "ArrowUp"].includes(event.key) || event.target.matches("input, select")) return;
  const rows = [...dialog.querySelectorAll('[data-s="list"] tr[data-s-pick], [data-s="list"] tr[data-s-agent-row]')];
  if (!rows.length) return;
  event.preventDefault();
  const current = rows.findIndex((row) => row.classList.contains("is-picked"));
  const next = rows[Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))];
  if (next.dataset.sAgentRow) { next.focus(); return; }
  ui.pick = next.dataset.sPick;
  renderBody();
  const row = dialog.querySelector('[data-s="list"] .is-picked');
  row?.focus({ preventScroll: true });
  row?.scrollIntoView({ block: "nearest" });
}
