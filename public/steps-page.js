// The Steps page (`?view=steps`): every open step of every unfinished task, grouped by who makes the next move, with an
// inspector for the selected step. The Outbox is the same page filtered to outbound kinds (`&kind=outbound`).
import { isSettled, renderWorkGraph, settledWork, showDoneToggle, workStatusIcon } from "./actions.js";
import { GLYPHS } from "./icons.js";
import { escapeHtml, inlineMarkdown, renderMarkdown } from "./markdown.js";

// A step title for a list row, where the row is the button and links can't be real: the text before " — ", a Markdown
// link reads as its label (a file name loses its folder and `.md`), a parenthetical that is only a link goes, and code
// spans stay code. The inspector and dialog render the full title with real links.
const linkLabel = (label) => label.replace(/^.*\//, "").replace(/\.md$/, "");
export const stepTitleText = (title = "") => title.split(" — ")[0]
  .replace(/\s*\(\s*\[[^\]]*\]\([^)]*\)\s*\)/g, "")
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, (_, label) => linkLabel(label))
  .replace(/\*\*([^*]+)\*\*/g, "$1");
export const stepTitleHtml = (title, query = "") => highlightHtml(escapeHtml(stepTitleText(title)).replace(/`([^`]+)`/g, "<code>$1</code>"), query);

// The filter box: whitespace-separated words, all of which must appear somewhere in a step (its title, IDs, task, kind,
// why it is where it is, an outbound draft's target); `-word` leaves out the steps that have it.
export const queryTerms = (query = "") => query.toLowerCase().split(/\s+/).filter((term) => term && term !== "-").map((term) => term.startsWith("-") ? { not: true, term: term.slice(1) } : { not: false, term });
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Marks the filter's words in already-escaped HTML, outside tags and entities.
export function highlightHtml(html, query = "") {
  const terms = queryTerms(query).filter((t) => !t.not).map((t) => escapeRegex(escapeHtml(t.term)));
  if (!terms.length) return html;
  const re = new RegExp(`(${terms.sort((a, b) => b.length - a.length).join("|")})`, "gi");
  return html.split(/(<[^>]*>|&[#\w]+;)/).map((part) => /^[<&]/.test(part) && part.length > 1 ? part : part.replace(re, "<mark>$1</mark>")).join("");
}
import { outboundIcon, outboundKindLabel, outboundPanel } from "./outbound.js";

export const MOVES = {
  "you-decide": { group: "You decide", label: "You" },
  "you-act": { group: "You act · friction", label: "You" },
  agent: { group: "Agent", label: "Agent" },
  others: { group: "Others", label: "Others" },
  blocked: { group: "Blocked", label: "Blocked" },
  unclassified: { group: "Needs a kind", label: "Unclassified" },
  flags: { group: "Agent flags · for the daily retro", label: "Flag" },
};
const ORDER = ["you-decide", "you-act", "agent", "others", "blocked", "unclassified"];
const HIDDEN = new Set(["blocked", "unclassified"]);
const OUTBOUND = new Set(["jira-issue", "jira-comment", "jira-edit", "jira-transition", "it-ticket", "slack", "pr", "pr-comment", "review-request", "email"]);
// Agent friction flags (scripts/flag) have their own segment and stay out of All and Up next: the daily retro works them.
export const MOVE_FILTERS = { you: ["you-decide", "you-act"], agent: ["agent"], others: ["others"], flags: ["flags"], all: ORDER };
export const KIND_FILTERS = {
  any: ["Any kind", () => true],
  outbound: ["Outbound", (s) => OUTBOUND.has(s.kind)],
  decision: ["Decisions and choices", (s) => ["decision", "pick-one", "pick-any"].includes(s.kind)],
  agent: ["Agent work", (s) => ["agent", "check-in"].includes(s.kind)],
  byron: ["Only you", (s) => s.kind === "byron"],
  none: ["No kind yet", (s) => !s.kind],
};
const KIND_LABELS = { agent: "Agent", "check-in": "Check-in", decision: "Decision", "pick-one": "Choice", "pick-any": "Choice", "do-all": "Group", byron: "Only you", note: "Note", flag: "Agent flag" };
const noteLike = (step) => step.kind === "note" || step.kind === "flag";
export const kindLabel = (kind) => KIND_LABELS[kind] || (OUTBOUND.has(kind) ? outboundKindLabel(kind) : kind || "—");
export const stepKey = (step) => `${step.task}:${step.id}`;

// Priority: the server scores every step (`scoreStep` in steps.ts), sends the parts behind each score, and sends steps
// highest first. A row shows the score with a thin bar and its tier sets how loud the row is (top rows read first, low ones
// recede). Hovering the score (or focusing its row) opens a waterfall of the parts (attachScorePopover).
export const tierOf = (score = 0) => score >= 70 ? "top" : score >= 50 ? "mid" : "low";
export const scoreHtml = (step) => `<span class="step-score is-${tierOf(step.score)}" data-score-step="${escapeHtml(stepKey(step))}" aria-label="Priority ${step.score ?? 0} of 99"><span class="step-score-bar" style="--score:${(step.score ?? 0) / 99}"></span>${step.score ?? 0}</span>`;

// The waterfall: one row per part, its bar stepping from the running total before it to the one after (a gain in the
// accent, a loss in red, nothing as a tick), its signed points, and a detail line where one helps; the total last.
export function scoreWaterfallHtml(step) {
  const parts = step.scoreParts || [];
  let run = 0;
  const steps = parts.map((part) => { const from = run; run += part.points; return { ...part, from, to: run }; });
  const lo = Math.min(0, ...steps.map((s) => Math.min(s.from, s.to))), hi = Math.max(99, ...steps.map((s) => Math.max(s.from, s.to)));
  const x = (value) => `${((value - lo) / (hi - lo)) * 100}%`;
  const bar = (a, b, tone) => `<span class="score-wf-track"><span class="score-wf-bar is-${tone}" style="left:${x(Math.min(a, b))};width:${a === b ? "0px" : `calc(${x(Math.max(a, b))} - ${x(Math.min(a, b))})`}"></span>${lo < 0 ? `<span class="score-wf-zero" style="left:${x(0)}"></span>` : ""}</span>`;
  const signed = (n) => n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0";
  const rows = steps.map((s) => `<div class="score-wf-row${s.points ? "" : " is-zero"}"><span class="score-wf-label">${escapeHtml(s.label)}</span>${bar(s.from, s.to, s.points > 0 ? "up" : s.points < 0 ? "down" : "none")}<span class="score-wf-pts">${signed(s.points)}</span>${s.detail ? `<ul class="score-wf-detail">${s.detail.split("\n").map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>` : ""}</div>`).join("");
  const clamp = run !== step.score ? `<ul class="score-wf-detail"><li>${run > 99 ? `${run}, capped at 99` : `${run}, floored at 0`}</li></ul>` : "";
  return `<div class="score-wf"><header>Why it scores ${step.score ?? 0}</header>${rows}<div class="score-wf-row is-total"><span class="score-wf-label">Priority</span>${bar(0, step.score ?? 0, "total")}<span class="score-wf-pts">${step.score ?? 0}</span>${clamp}</div></div>`;
}

// One shared popover for every score on the page (rows, the inspector, the step dialog): it opens on hover of a score, or
// when keyboard focus lands on a row with one, sits beside the score inside the viewport, and closes on leave, blur,
// scroll or Esc. It is a top-layer popover, so it shows over dialogs and never moves the page.
export function attachScorePopover(lookup) {
  const pop = Object.assign(document.createElement("div"), { className: "score-pop", popover: "manual", role: "tooltip" });
  document.body.append(pop);
  let current = null, hideTimer = 0;
  const isOpen = () => pop.matches(":popover-open");
  const close = () => { clearTimeout(hideTimer); if (isOpen()) pop.hidePopover(); current = null; };
  const show = (el) => {
    clearTimeout(hideTimer);
    if (current === el && isOpen()) return;
    const step = lookup(el.dataset.scoreStep);
    if (!step?.scoreParts) return close();
    current = el;
    pop.innerHTML = scoreWaterfallHtml(step);
    if (!isOpen()) pop.showPopover();
    const r = el.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    const left = r.right + 10 + w <= innerWidth - 8 ? r.right + 10 : Math.max(8, r.left - w - 10);
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.min(Math.max(8, r.top + r.height / 2 - 24), innerHeight - h - 8)}px`;
  };
  const leave = () => { clearTimeout(hideTimer); hideTimer = setTimeout(close, 60); };
  document.addEventListener("pointerover", (event) => { const el = event.target.closest?.("[data-score-step]"); if (el) show(el); });
  document.addEventListener("pointerout", (event) => { const el = event.target.closest?.("[data-score-step]"); if (el && !el.contains(event.relatedTarget)) leave(); });
  document.addEventListener("focusin", (event) => {
    if (!event.target.matches?.(":focus-visible")) return;
    // Form controls in a row (the next-move select, checkboxes) are not the score: focusing one hides the card, never opens it.
    if (event.target.matches("select, input, textarea, [contenteditable]")) { if (current) close(); return; }
    const el = event.target.closest("tr, .step-row, .step-priority")?.querySelector("[data-score-step]");
    if (el) show(el); else if (current) close();
  });
  document.addEventListener("focusout", (event) => { if (current && !event.relatedTarget?.closest?.("tr, .step-row, .step-priority")?.contains(current)) leave(); });
  document.addEventListener("scroll", () => current && close(), true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && current) close(); });
}

// Sorts for the Steps page. Up next stays on top in all of them; Priority keeps the server's order.
const pinNext = (a, b) => Number(b.next) - Number(a.next);
export const SORTS = {
  priority: ["Priority", () => 0],
  unblocks: ["Unblocks most", (a, b) => (b.unblocks || 0) - (a.unblocks || 0)],
  small: ["Smallest first", (a, b) => ("SML".indexOf(a.size || "M") - "SML".indexOf(b.size || "M"))],
  oldest: ["Oldest first", (a, b) => b.age - a.age],
};
// Groups for the Steps table. Groups appear in the order of their highest-ranked step, except status and next move,
// which keep their own order; rows inside a group keep the sort.
const STATUS_ORDER = ["active", "open", "waiting", "deferred"];
export const GROUPS = {
  none: ["No grouping", null],
  task: ["Task", (step) => step.task || "Notes"],
  move: ["Next move", (step) => step.move],
  kind: ["Kind", (step) => step.kind || ""],
  status: ["Status", (step) => step.status],
};
export const sortSteps = (steps, sort = "priority") => [...steps].sort((a, b) => pinNext(a, b) || (SORTS[sort] || SORTS.priority)[1](a, b) || (b.score || 0) - (a.score || 0));

// Facets: each narrows the table to the values ticked in its menu (`&task=TASK-0101,TASK-0102`; `none` is the empty value).
// A menu's counts are what each value would show with every other filter applied, the next-move segment included.
const AGE_BUCKETS = { new: "New today", week: "1–7 days", fortnight: "8–14 days", older: "Over two weeks" };
const DRAFT_STATUS = { ready: "Ready for you", draft: "Drafting", revise: "Being revised", approved: "Sending", failed: "Didn't send" };
const capital = (text) => text ? text[0].toUpperCase() + text.slice(1) : text;
export const FACETS = {
  task: { label: "Task", value: (s) => s.task || "", text: (v, s) => v ? `${v} ${s?.taskTitle || ""}` : "Saved notes", short: (v) => v || "Notes", search: true },
  kinds: { label: "Kind", value: (s) => s.kind || "", text: (v) => v ? kindLabel(v) : "No kind yet" },
  size: { label: "Size", value: (s) => s.size || "", text: (v) => v || "No size", order: ["S", "M", "L", ""] },
  status: { label: "Status", value: (s) => s.status || "", text: capital, order: STATUS_ORDER },
  age: { label: "Age", value: (s) => !s.age ? "new" : s.age <= 7 ? "week" : s.age <= 14 ? "fortnight" : "older", text: (v) => AGE_BUCKETS[v], order: Object.keys(AGE_BUCKETS) },
  draft: { label: "Draft", value: (s) => s.draft?.fields?.status || "", text: (v) => v ? DRAFT_STATUS[v] || capital(v) : "No draft", order: Object.keys(DRAFT_STATUS), outbox: true },
};
// The Kind menu's shortcuts, which tick a set of kinds at once (and what an old `&kind=decision` link opens).
export const presetKinds = { decision: ["decision", "pick-one", "pick-any"], agent: ["agent", "check-in"], byron: ["byron"], none: [""] };
export const facetNames = (filters) => Object.keys(FACETS).filter((name) => !FACETS[name].outbox || filters.kind === "outbound");
export const activeFilterCount = (filters) => facetNames(filters).filter((name) => filters[name]?.length).length + (queryTerms(filters.q).length ? 1 : 0);

const haystack = (s) => [stepTitleText(s.title), s.id, s.task, s.taskTitle, s.kind && kindLabel(s.kind), s.reason, s.fix, s.draft?.fields?.target].filter(Boolean).join(" ").toLowerCase();
// Every filter but the next move: the page's scope (`kind`: the Outbox is `outbound`), the facets (all but `except`) and the words.
export function filterSteps(steps, filters = {}, except = "") {
  const scope = KIND_FILTERS[filters.kind]?.[1] || (() => true);
  const terms = queryTerms(filters.q);
  const facets = facetNames(filters).filter((name) => name !== except && filters[name]?.length);
  return steps.filter((step) => scope(step)
    && facets.every((name) => filters[name].includes(FACETS[name].value(step)))
    && (!terms.length || ((text) => terms.every(({ not, term }) => text.includes(term) !== not))(haystack(step))));
}

// `next` (Up next) is a filter across movers, not a mover: every step flagged `{next}`, blocked ones too.
const moveTest = (move, hidden) => move === "next" ? (step) => step.next
  : ((moves) => (step) => moves.includes(step.move) && (hidden || move !== "all" || !HIDDEN.has(step.move)))(MOVE_FILTERS[move] || ORDER);
export function visibleSteps(steps, filters = {}, except = "") {
  return filterSteps(steps, filters, except).filter(moveTest(filters.move || "all", filters.hidden));
}

export function moveCounts(steps, kind = "any") {
  const test = KIND_FILTERS[kind]?.[1] || (() => true);
  const of = (moves) => steps.filter((step) => moves.includes(step.move) && test(step)).length;
  return { next: steps.filter((step) => step.next && test(step)).length, you: of(MOVE_FILTERS.you), agent: of(MOVE_FILTERS.agent), others: of(MOVE_FILTERS.others), flags: of(MOVE_FILTERS.flags), all: of(ORDER.filter((m) => !HIDDEN.has(m))) };
}

// One facet's menu: a find box for long lists (Task), shortcuts for Kind, then one row per value with a tick and its count.
// Values ticked but now empty stay listed, so they can be unticked. `active` is the keyboard row.
export function facetMenuHtml(name, steps, filters, { find = "", active = 0 } = {}) {
  const facet = FACETS[name];
  const picked = filters[name] || [];
  const pool = visibleSteps(steps, filters, name);
  // Rows keep one order while the menu is open (by how many steps each value has in the page's scope), so ticking one
  // never moves the row under the cursor.
  const counts = new Map(), sample = new Map(), total = new Map();
  for (const step of filterSteps(steps, { kind: filters.kind })) { const v = facet.value(step); counts.set(v, 0); total.set(v, (total.get(v) || 0) + 1); sample.set(v, sample.get(v) || step); }
  for (const step of pool) { const v = facet.value(step); counts.set(v, (counts.get(v) || 0) + 1); }
  for (const v of picked) if (!counts.has(v)) counts.set(v, 0);
  const rank = (v) => facet.order ? (facet.order.indexOf(v) + 1 || 99) : 0;
  const needle = find.trim().toLowerCase();
  const values = [...counts.keys()]
    .filter((v) => !needle || facet.text(v, sample.get(v)).toLowerCase().includes(needle))
    .sort((a, b) => rank(a) - rank(b) || (total.get(b) || 0) - (total.get(a) || 0) || String(a).localeCompare(String(b)));
  const index = Math.max(0, Math.min(active, values.length - 1));
  const label = (v) => {
    const text = facet.text(v, sample.get(v));
    if (name !== "task" || !v) return highlightHtml(escapeHtml(text), needle);
    return `<code>${highlightHtml(escapeHtml(v), needle)}</code> ${highlightHtml(escapeHtml(text.slice(v.length + 1)), needle)}`;
  };
  const rows = values.map((v, i) => `<li role="option" data-facet-value="${escapeHtml(v || "none")}" aria-selected="${picked.includes(v)}"${i === index ? ' class="is-active"' : ""}${counts.get(v) ? "" : ' data-empty="true"'}><span class="step-facet-tick" aria-hidden="true"></span><span class="step-facet-text">${label(v)}</span><span class="step-facet-count">${counts.get(v)}</span></li>`).join("");
  const presets = name === "kinds" && filters.kind !== "outbound" ? `<div class="step-facet-presets">${["decision", "agent", "byron"].map((key) => `<button type="button" data-facet-preset="${key}">${escapeHtml(KIND_FILTERS[key][0])}</button>`).join("")}</div>` : "";
  const findBox = facet.search || counts.size > 12 ? `<label class="code-filter"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.search}</svg><input type="search" data-facet-find placeholder="Find a ${facet.label.toLowerCase()}" value="${escapeHtml(find)}" spellcheck="false" autocomplete="off"></label>` : "";
  const clear = picked.length ? `<button type="button" class="step-facet-clear" data-facet-clear>Clear ${escapeHtml(facet.label.toLowerCase())}</button>` : "";
  return `${findBox}${presets}<ul class="step-facet-list" role="listbox" aria-multiselectable="true" aria-label="${escapeHtml(facet.label)}">${rows || `<li class="step-facet-none">No ${escapeHtml(facet.label.toLowerCase())} matches.</li>`}</ul>
    <footer><span><kbd>↑</kbd><kbd>↓</kbd> · <kbd>Enter</kbd> tick · <kbd>⇧</kbd><kbd>Enter</kbd> only · <kbd>Esc</kbd></span>${clear}</footer>`;
}

// A facet's toolbar button names what it holds: `Task`, `Task: TASK-0136`, `Kind · 3`.
const CHEVRON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>`;
function facetButtonHtml(name, filters) {
  const facet = FACETS[name], picked = filters[name] || [];
  const text = picked.length === 1 ? `${facet.label}: ${(facet.short || facet.text)(picked[0])}` : picked.length ? `${facet.label} · ${picked.length}` : facet.label;
  return `<button type="button" class="step-facet${picked.length ? " is-on" : ""}" data-step-facet="${name}" aria-haspopup="listbox" aria-expanded="false"${picked.length > 1 ? ` title="${escapeHtml(picked.map((v) => facet.text(v)).join(", "))}"` : ""}><span>${escapeHtml(text)}</span>${CHEVRON}</button>`;
}

const pill = (step) => {
  const tone = step.move === "you-act" ? "friction" : step.move === "you-decide" ? "you" : step.move;
  const short = step.move === "you-act" ? (step.draft ? "send by hand" : "act") : step.reason.length > 16 ? "decide" : step.reason;
  const text = step.move === "agent" ? `Agent · ${step.running ? "running" : step.reason}` : step.move.startsWith("you") ? `You · ${short}` : MOVES[step.move].label;
  return `<span class="step-move step-move-${tone}" title="${escapeHtml(step.reason)}">${escapeHtml(text)}</span>`;
};

// One table row, editable in place: Done, Up next, the title (double-click), kind, size and status write the step's line
// in its task file through /api/steps/edit, without selecting the row. A note or an outbound draft's step keeps what its
// file owns read-only. The rest of the row selects the step for the inspector.
const EDIT_KINDS = ["agent", "check-in", "decision", "byron", "pick-one", "pick-any", "do-all", ...OUTBOUND];
const select = (field, value, options, label) => `<select class="step-cell-edit" data-step-edit="${field}" aria-label="${label}">${options.map(([v, text]) => `<option value="${escapeHtml(v)}"${v === value ? " selected" : ""}>${escapeHtml(text)}</option>`).join("")}</select>`;
export function stepRowCells(step, { withTask = true, query = "" } = {}) {
  const note = noteLike(step);
  const kindCell = note ? kindLabel(step.kind) : select("kind", step.kind, [["", "—"], ...EDIT_KINDS.map((k) => [k, kindLabel(k)])], "Kind");
  const sizeCell = note ? "" : select("size", step.size, [["", "—"], ["S", "S"], ["M", "M"], ["L", "L"]], "Size");
  const statusCell = note ? "" : select("status", step.status, STATUS_ORDER.map((st) => [st, st[0].toUpperCase() + st.slice(1)]), "Status");
  const done = `<input type="checkbox" class="step-done-box" data-step-done aria-label="Mark ${escapeHtml(step.id)} done" title="Mark done">`;
  const next = `<button type="button" class="step-next-cell" data-step-next aria-pressed="${Boolean(step.next)}" title="${step.next ? "On Up next: click to take it off" : "Queue it as Up next"}" aria-label="Up next">●</button>`;
  return `<td class="step-col-done">${done}</td>
    <td class="step-col-score">${scoreHtml(step)}</td>
    <td class="step-col-title"><span class="step-title-cell"${note ? "" : ' data-step-title-edit title="Double-click to edit the title"'}>${stepTitleHtml(step.title, query)}</span></td>
    <td class="step-col-next">${note ? "" : next}</td>
    <td class="step-col-move">${movePill(step)}</td>
    <td class="step-col-kind">${kindCell}</td>
    <td class="step-col-size">${sizeCell}</td>
    <td class="step-col-status">${statusCell}</td>
    ${withTask ? `<td class="step-col-work"><button class="task-list-id" type="button" data-task-path="${escapeHtml(step.path)}">${highlightHtml(escapeHtml(step.task || "Note"), query)}</button><span class="step-task-name">${highlightHtml(escapeHtml(step.taskTitle), query)}</span></td>` : ""}
    <td class="step-col-age">${step.running ? "running" : step.age ? `${step.age}d` : "new"}</td>`;
}
function row(step, selected, withTask, query) {
  return `<tr class="step-tier-${tierOf(step.score)}" data-select-step="${escapeHtml(stepKey(step))}" aria-selected="${selected}" tabindex="0">${stepRowCells(step, { withTask, query })}</tr>`;
}

// A friction group's fixes, once each in its header instead of under every row.
const fixesHtml = (list) => [...new Set(list.map((step) => step.fix).filter(Boolean))].map((fix) => `<em class="step-group-fix">fix: ${escapeHtml(fix)}</em>`).join("");

// A group's header: its name, count and top score; a task group also names the task and sets its priority in place. A
// task, kind or status group offers "Only this", which narrows the table to it through that facet.
const GROUP_FACETS = { task: "task", kind: "kinds", status: "status" };
function groupHead(group, key, list, columns, filters = {}) {
  const first = list[0];
  const name = group === "task" ? `<button class="task-list-id" type="button" data-task-path="${escapeHtml(first.path)}">${escapeHtml(first.task || "Notes")}</button><span class="step-group-name">${escapeHtml(first.task ? first.taskTitle : "Saved notes")}</span>`
    : group === "move" ? `<span class="step-group-name">${escapeHtml(MOVES[key]?.group || key)}</span>${fixesHtml(list)}`
    : group === "kind" ? `<span class="step-group-name">${escapeHtml(key ? kindLabel(key) : "No kind yet")}</span>`
    : `<span class="step-group-name">${escapeHtml(key[0].toUpperCase() + key.slice(1))}</span>`;
  const priority = group === "task" && first.task ? `<span class="step-toggle step-group-priority" role="group" aria-label="${escapeHtml(first.task)} priority">${["p1", "p2", "p3"].map((p) => `<button type="button" data-task-priority="${p}" data-path="${escapeHtml(first.path)}" aria-pressed="${(first.priority || "p2") === p}">${p.toUpperCase()}</button>`).join("")}</span>` : "";
  const facet = GROUP_FACETS[group];
  const only = facet && !(filters[facet]?.length === 1 && filters[facet][0] === key) ? `<button type="button" class="step-group-only" data-step-only="${facet}" data-value="${escapeHtml(key || "none")}">Only this</button>` : "";
  return `<tr class="step-group"><th colspan="${columns}" scope="rowgroup"><span class="step-group-line">${name}<span class="step-group-count">${list.length} ${list.length === 1 ? "step" : "steps"} · top ${Math.max(...list.map((step) => step.score || 0))}</span>${only}${priority}</span></th></tr>`;
}

export function stepsTableHtml(steps, filters, selected) {
  const shown = visibleSteps(steps, filters);
  if (!shown.length) {
    const narrowed = activeFilterCount(filters);
    const elsewhere = narrowed && filters.move !== "all" ? visibleSteps(steps, { ...filters, move: "all" }).length : 0;
    if (narrowed) return `<p class="task-empty">No steps here match these filters.${elsewhere ? ` <button type="button" class="step-empty-clear" data-step-move="all">Show ${elsewhere} under All</button>` : ""} <button type="button" class="step-empty-clear" data-step-clear>Clear filters</button></p>`;
    return `<p class="task-empty">${filters.move === "next" ? "Nothing is up next. Press Up next on a step, or Save note (Enter) in the composer." : filters.kind === "outbound" ? "Nothing waiting to go out." : "No open steps match."}</p>`;
  }
  const sorted = sortSteps(shown, filters.sort);
  const group = GROUPS[filters.group]?.[1] ? filters.group : "none";
  const keyOf = GROUPS[group][1];
  const keys = !keyOf ? [""] : group === "move" ? [...ORDER, "flags"] : group === "status" ? STATUS_ORDER : [...new Set(sorted.map(keyOf))];
  const groups = keys.map((key) => [key, keyOf ? sorted.filter((step) => keyOf(step) === key) : sorted]).filter(([, list]) => list.length);
  const withTask = group !== "task";
  const columns = withTask ? 10 : 9;
  return `<table class="task-table step-table${keyOf ? " is-grouped" : ""}">
    <thead><tr><th scope="col" class="step-col-done" aria-label="Done"></th><th scope="col" class="step-col-score">Priority</th><th scope="col">Step</th><th scope="col" class="step-col-next" title="Up next">Next</th><th scope="col" class="step-col-move">Move</th><th scope="col">Kind</th><th scope="col">Size</th><th scope="col">Status</th>${withTask ? '<th scope="col" class="step-col-work">Task</th>' : ""}<th scope="col" class="step-col-age">Age</th></tr></thead>
    ${groups.map(([key, list]) => `<tbody>${keyOf ? groupHead(group, key, list, columns, filters) : ""}${list.map((step) => row(step, stepKey(step) === selected, withTask, filters.q)).join("")}</tbody>`).join("")}
  </table>`;
}

// The toolbar: next-move segments (counts follow every other filter), the filter box, one menu per facet, a count of what
// is shown with Clear when anything narrows it, then group and sort.
export function stepsToolbarHtml(steps, filters, slots, runs = 0) {
  const scoped = filterSteps(steps, filters);
  const counts = moveCounts(scoped);
  const seg = (key, label) => `<button type="button" class="step-seg" data-step-move="${key}" aria-pressed="${filters.move === key}">${label} <span>${counts[key]}</span></button>`;
  const hiddenCount = scoped.filter((step) => HIDDEN.has(step.move)).length;
  const narrowed = activeFilterCount(filters);
  const shown = visibleSteps(steps, filters).length;
  const scopeTotal = visibleSteps(steps, { kind: filters.kind, move: filters.move, hidden: filters.hidden }).length;
  return `<div class="task-index-tools step-tools">
    <span class="step-segs" role="group" aria-label="Next move">${seg("next", "Up next")}${seg("you", "Next move: You")}${seg("agent", "Agent")}${seg("others", "Others")}${seg("flags", "Agent flags")}${seg("all", "All")}</span>
    <label class="code-filter step-filter"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS.search}</svg><input type="search" data-step-query placeholder="Filter steps" value="${escapeHtml(filters.q || "")}" spellcheck="false" autocomplete="off" aria-label="Filter steps: words to match, -word to leave out"><kbd aria-hidden="true">/</kbd></label>
    <span class="step-facets" role="group" aria-label="Filters">${facetNames(filters).map((name) => facetButtonHtml(name, filters)).join("")}</span>
    <span class="step-shown${narrowed ? " is-narrowed" : ""}">${narrowed ? `<span>${shown} of ${scopeTotal}</span><button type="button" class="step-clear" data-step-clear title="Clear the filter box and every menu">Clear</button>` : ""}</span>
    <span class="step-arrange"><select class="step-kind" data-step-group aria-label="Group">${Object.entries(GROUPS).map(([key, [label]]) => `<option value="${key}"${(filters.group || "none") === key ? " selected" : ""}>${key === "none" ? "Group: none" : `Group: ${label.toLowerCase()}`}</option>`).join("")}</select>
    <select class="step-kind" data-step-sort aria-label="Sort">${Object.entries(SORTS).map(([key, [label]]) => `<option value="${key}"${(filters.sort || "priority") === key ? " selected" : ""}>Sort: ${label.toLowerCase()}</option>`).join("")}</select></span>
    ${filters.move === "all" && hiddenCount ? `<label class="show-done"><input type="checkbox" data-step-hidden${filters.hidden ? " checked" : ""}> Show ${hiddenCount} blocked or without a kind</label>` : ""}
    <span class="step-slots" title="Agent runs started from this page">${runs} of ${slots} agent slots in use</span>
  </div>`;
}

// The shared step list (today's plan, a task's Steps panel, the World's Today column, the step dialog's rail): one line per
// step, a short state pill only where it says who moves next, the full title, and right-aligned gray meta. Every row opens
// the step dialog (`data-open-step`); none navigates.
const PILLS = { "you-decide": ["you", "Decide"], "you-act": ["friction", "Friction"], agent: ["agent", "Agent"], others: ["others", "Waiting"], flags: ["flag", "Flag"], blocked: ["blocked", "Blocked"], unclassified: ["unclassified", "No kind"] };
export const movePill = (step) => {
  const [tone, label] = PILLS[step.move] || PILLS.unclassified;
  return `<span class="step-move step-move-${tone}" title="${escapeHtml(step.reason)}">${step.running ? "Running" : label}</span>`;
};
const TOGGLE_LABELS = { next: "Up next", you: "You", agent: "Agent", others: "Others", all: "All" };
const MOVER_KEYS = ["you", "agent", "others", "all"];
// A thin segmented control; `counts` adds a number to each segment, `keys` picks the segments.
export const stepToggleHtml = (move, counts = null, keys = MOVER_KEYS) => `<span class="step-toggle" role="group" aria-label="Next move">${keys.map((key) => `<button type="button" data-step-list-move="${key}" aria-pressed="${move === key}">${TOGGLE_LABELS[key]}${counts && key !== "all" ? ` <span>${counts[key]}</span>` : ""}</button>`).join("")}</span>`;
// Every segment's rows are rendered into one grid cell and only the chosen one is visible, so the panel is always as tall as
// its fullest segment and switching never moves what follows it. `layers` maps a segment to its HTML.
export const stepStackHtml = (move, layers) => `<div class="step-stack">${Object.entries(layers).map(([key, html]) => `<div class="step-layer" data-step-layer="${key}"${key === move ? "" : " inert"}>${html}</div>`).join("")}</div>`;
// Shows one segment of a stack rendered by stepStackHtml; the caller keeps the choice in the URL.
export function showStepLayer(panel, move) {
  for (const button of panel.querySelectorAll("[data-step-list-move]")) button.setAttribute("aria-pressed", String(button.dataset.stepListMove === move));
  for (const layer of panel.querySelectorAll("[data-step-layer]")) layer.inert = layer.dataset.stepLayer !== move;
}
// With `noteHtml` (a note that holds links) the row is a div whose title is the button, so the links stay real links.
export const stepRowHtml = ({ key, lead = "", pill = "", title, note = "", noteHtml = "", meta = "", className = "" }) => noteHtml
  ? `<div class="step-row${className}" data-open-step="${escapeHtml(key)}"><span class="step-row-lead">${lead}</span><span class="step-row-title">${pill}<button type="button" class="step-row-open" data-open-step="${escapeHtml(key)}">${stepTitleHtml(title)}</button><span class="step-row-note">${noteHtml}</span></span><span class="step-row-meta">${meta}</span></div>`
  : `<button type="button" class="step-row${className}" data-open-step="${escapeHtml(key)}"><span class="step-row-lead">${lead}</span><span class="step-row-title">${pill}${stepTitleHtml(title)}${note ? `<span class="step-row-note">${escapeHtml(note)}</span>` : ""}</span><span class="step-row-meta">${meta}</span></button>`;

// The segment a short step list opens on: the first mover with anything waiting, You first.
export const firstMove = (counts) => ["you", "agent", "others"].find((move) => counts[move]) || "all";

// A short step list with its toggle (today's plan, a task in the Tasks inspector, a task's World): every segment
// pre-rendered in one cell, `cap` rows each. `withTask` puts the task beside the step ID; `more(name, count)` renders
// what follows a segment longer than the cap. `only` renders just the chosen segment, with no toggle or reserved height.
export function stepListHtml(steps, { move = firstMove(moveCounts(steps)), cap = 8, withTask = false, more = () => "", only = false } = {}) {
  const layer = (name) => {
    const shown = visibleSteps(steps, { move: name });
    const rows = shown.slice(0, cap).map((step) => stepRowHtml({ key: stepKey(step), lead: `${scoreHtml(step)}${movePill(step)}`, title: step.title,
      meta: escapeHtml(withTask ? `${step.task} ${step.id}` : step.id), className: ` is-ranked step-tier-${tierOf(step.score)}` })).join("");
    return `<div class="step-rows">${rows || `<p class="step-rows-empty">${name === "you" ? "Nothing waits on you." : name === "next" ? "Nothing is up next." : "No steps here."}</p>`}</div>${shown.length > cap ? more(name, shown.length) : ""}`;
  };
  if (only) return { toggle: "", stack: layer(move) };
  const keys = ["next", ...MOVER_KEYS];
  return { toggle: stepToggleHtml(move, moveCounts(steps), keys), stack: stepStackHtml(move, Object.fromEntries(keys.map((name) => [name, layer(name)]))) };
}

// A plan's Scheduled tasks section: one row per task bullet, keyed by the first task it names, with the plan's note for it
// as Markdown (whatever follows that task's link or ID; indented lines under it continue the note). A bullet that links
// several tasks before its note (`- [TASK-0136](…), [TASK-0134](…): …`) stays one row; the others lead its note as links.
export function scheduledTasks(markdown) {
  const rows = [], rest = [];
  for (const line of markdown.split("\n")) {
    const id = /^[-*] /.test(line) && line.match(/TASK-\d{4}/)?.[0];
    if (id) rows.push({ id, note: line.replace(/^[-*]\s+(?:\[[^\]]*\]\([^)]*\)|\S*TASK-\d{4}\S*)/, "").replace(/^[\s,;:—–-]+/, "") });
    else if (rows.length && /^\s+\S/.test(line)) rows.at(-1).note += ` ${line.trim().replace(/^[-*] /, "")}`;
    else rest.push(line);
  }
  for (const row of rows) row.note = row.note.trim();
  return { rows, rest: rest.join("\n") };
}

// A task's Steps panel (its page and its dock's Work panel): the toggle with this task's counts, then every step under a
// light header line per workstream (top-level item), each row with its ID, status icon, a pill only when it waits on you,
// the full title, and gray meta (`ready`, `after W1.2`, `running`, its note count). Completed and deferred steps sit behind
// one quiet toggle at the bottom. `tools` (the page, not the dock) adds Graph, a popover with the dependency graph, and World.
const CHOICE_KINDS = new Set(["pick-one", "pick-any"]);
export function taskStepsHtml({ taskId = "", work, steps = [], actions = [], noteCount = () => 0, showDone = false, move = "all", tools = true }) {
  const { nodes } = work;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = (id) => nodes.filter((n) => n.parent === id);
  const settled = settledWork(nodes);
  // A step is a leaf, a choice (its options show inside it), or a live item whose children are all settled.
  const isRow = (n) => !CHOICE_KINDS.has(byId.get(n.parent)?.kind) && (CHOICE_KINDS.has(n.kind) || !kids(n.id).length || (!settled.has(n.id) && kids(n.id).every((c) => settled.has(c.id))));
  const topOf = (n) => { while (byId.get(n.parent)) n = byId.get(n.parent); return n; };
  const stepOf = (id) => steps.find((step) => step.id === id);
  const rows = nodes.filter(isRow);
  const inLayer = (n, layer) => layer === "all" || (!settled.has(n.id) && MOVE_FILTERS[layer].includes(stepOf(n.id)?.move));
  const key = (n) => `${taskId}:${n.id}`;
  const meta = (n) => {
    const step = stepOf(n.id);
    const waiting = n.deps.filter((dep) => byId.get(dep)?.status !== "completed");
    const state = step?.running ? "running" : isSettled(n.status) || n.status === "waiting" ? n.status : waiting.length ? `after ${waiting.join(", ")}` : n.status === "active" ? "active" : n.ready ? "ready" : n.status;
    const notes = noteCount(n.id);
    return `${notes ? `<span class="step-row-notes" title="${notes} ${notes === 1 ? "update" : "updates"}"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS["message-square"]}</svg>${notes}</span>` : ""}${escapeHtml(state)}`;
  };
  const row = (n) => {
    const step = stepOf(n.id);
    return stepRowHtml({ key: key(n), lead: `<code class="step-row-id">${escapeHtml(n.id)}</code>${workStatusIcon(n, nodes)}`, pill: step?.move.startsWith("you") ? movePill(step) : "", title: n.title, meta: meta(n), className: settled.has(n.id) ? " is-settled" : "" });
  };
  // A workstream with steps under it is a group, not a step: a muted header with a group glyph where a step's status
  // icon sits, and its progress (a thin bar, then `3 open · 5 done`) where a step's state sits.
  const workstreamHead = (top) => {
    const under = rows.filter((n) => n !== top && topOf(n) === top);
    const done = under.filter((n) => settled.has(n.id)).length;
    const open = under.length - done;
    const progress = `<span class="step-group-bar" style="--done: ${under.length ? Math.round((done / under.length) * 100) : 0}%" aria-hidden="true"></span>${[open && `${open} open`, done && `${done} done`].filter(Boolean).join(" · ")}`;
    return `<button type="button" class="step-group-head${settled.has(top.id) ? " is-settled" : ""}" data-open-step="${escapeHtml(key(top))}" aria-label="${escapeHtml(`${top.id} group: ${open} open, ${done} done`)}"><span class="step-row-lead"><code class="step-row-id">${escapeHtml(top.id)}</code><span class="work-status-icon is-group"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS["list-tree"]}</svg></span></span><span class="step-group-title">${stepTitleHtml(top.title)}</span><span class="step-row-meta">${progress}</span></button>`;
  };
  const layer = (name) => {
    const html = nodes.filter((n) => !n.parent).map((top) => {
      const list = rows.filter((n) => topOf(n) === top && inLayer(n, name));
      if (!list.length) return "";
      return (isRow(top) ? "" : workstreamHead(top)) + list.map(row).join("");
    }).join("");
    return `<div class="step-rows">${html || `<p class="step-rows-empty">No steps wait on ${name === "you" ? "you" : name === "agent" ? "an agent" : "others"}.</p>`}</div>`;
  };
  const count = (name) => rows.filter((n) => !settled.has(n.id) && inLayer(n, name)).length;
  const counts = { you: count("you"), agent: count("agent"), others: count("others") };
  const settledRows = rows.filter((n) => settled.has(n.id)).length;
  const graph = tools ? `<button type="button" class="code-bar-button" popovertarget="task-steps-graph" style="anchor-name: --task-steps-graph" aria-expanded="false">Graph</button>
    <div class="step-graph" id="task-steps-graph" popover style="position-anchor: --task-steps-graph" role="dialog" aria-label="Dependency graph"><header><strong>Dependency graph</strong><span>Prerequisite → dependent</span><button type="button" class="work-graph-expand" data-graph-expand aria-label="Expand dependency graph" title="Expand"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/></svg></button></header>${renderWorkGraph(work, actions, "steps", noteCount)}</div>
    ${taskId ? `<button type="button" class="code-bar-button" data-world-task-open="${escapeHtml(taskId)}" title="Everything filed for ${escapeHtml(taskId)} on one timeline (W)">World</button>` : ""}` : "";
  return `<div class="task-steps step-panel"${tools ? ' data-move-default="all"' : ""}>
    <div class="task-steps-tools">${stepToggleHtml(move, counts)}<span class="task-steps-spacer"></span>${graph}</div>
    ${stepStackHtml(move, Object.fromEntries(Object.keys(MOVE_FILTERS).map((name) => [name, layer(name)])))}
    ${settledRows ? showDoneToggle(settledRows, `data-show-done-work${showDone ? " checked" : ""}`) : ""}
  </div>`;
}

function optionsHtml(step) {
  const type = step.kind === "pick-one" ? "radio" : "checkbox";
  const ordered = [...step.options].sort((a, b) => b.recommended - a.recommended);
  return `<form class="step-choice" data-step-pick="${escapeHtml(stepKey(step))}">
    ${ordered.map((option) => `<label class="step-option"><input type="${type}" name="pick" value="${escapeHtml(option.id)}"${option.recommended && type === "radio" ? " checked" : ""}>
      <span><strong>${escapeHtml(option.title)}</strong>${option.recommended ? '<em class="step-recommended">Recommended</em>' : ""}${option.tradeoff ? `<span>${escapeHtml(option.tradeoff)}</span>` : ""}</span></label>`).join("")}
    <div class="outbound-actions"><button type="submit" class="outbound-primary">Pick</button><span class="step-choice-note">${step.kind === "pick-any" ? "Tick any; none is a choice too." : "One option becomes the next step."}</span></div>
  </form>`;
}

// An agent prompt is prose, so it renders as Markdown on a tinted surface (the step dialog and the Steps inspector share it).
export const promptHtml = (prompt, path = "") => `<div class="step-prompt"><div class="markdown">${renderMarkdown(prompt, path)}</div></div>`;
// A statement or rule is code: a highlighted code block, not raw text in a box.
const codeHtml = (code, language = "") => `<div class="markdown">${renderMarkdown(`\`\`\`${language}\n${code}\n\`\`\``)}</div>`;

const READ_ONLY = /^\s*\(*\s*(select|with|show|describe|desc)\b/i;
const readOnly = (sql) => READ_ONLY.test(sql) && !sql.trim().replace(/;\s*$/, "").includes(";");
const button = (action, label, primary = false, disabled = "") => `<button type="button" class="${primary ? "outbound-primary" : "outbound-secondary"}" data-step-action="${action}"${disabled ? ` disabled title="${escapeHtml(disabled)}"` : ""}>${label}</button>`;

// What the inspector lets you do now: start an agent, run or copy a statement, apply a rule, or mark it done.
// `compact` (the step dialog's header) drops the explanatory notes beside the buttons.
// Note… and Up next ride along with every step's own actions: a note (an approval, decision or direction) waits for an
// agent thread under Up next, standing in for the step; Up next queues the step itself.
export function stepActionsHtml(step, context = {}) {
  if (step.kind === "flag") return `<div class="outbound-actions step-actions">${button("done", "Mark done", true)}${context.compact ? "" : '<span class="step-choice-note">The daily retro works flags into a finding or a fix; mark it done when that\'s handled.</span>'}</div>`;
  if (step.kind === "note") return `<div class="outbound-actions step-actions">${button("done", "Mark done", true)}${context.compact ? "" : '<span class="step-choice-note">An agent works it into its source; mark it done when that\'s handled.</span>'}</div>`;
  const own = ownActionsHtml(step, context);
  const next = `<button type="button" class="outbound-secondary step-next-toggle" data-step-action="next" aria-pressed="${Boolean(step.next)}" title="${step.next ? "Take it off the Up next queue" : "Queue it for an agent thread: planboard next lists it"}">${step.next ? "● Up next" : "Up next"}</button>`;
  const note = step.kind === "decision" ? "" : `<button type="button" class="outbound-secondary" data-step-action="note" title="Approve, decide or direct it in your own words; an agent carries it through from Up next">Note…</button>`;
  return own.includes('class="outbound-actions') ? own.replace(/<\/div>$/, `${note}${next}</div>`) : `${own}<div class="outbound-actions step-actions">${note}${next}</div>`;
}
function ownActionsHtml(step, { startConfigured = false, runConfigured = false, freeSlots = 0, compact = false } = {}) {
  const f = step.machinery?.fields || {};
  const note = (text) => compact ? "" : `<span class="step-choice-note">${text}</span>`;
  if (step.draft) return ""; // an outbound step's panel has its own Approve, Mark sent and Drop
  if (step.move === "agent" && !step.draft && !step.running) {
    const why = !startConfigured ? "Set steps.start in config/viewer.json" : freeSlots < 1 ? "All agent slots are in use" : "";
    return `<div class="outbound-actions step-actions">${button("start", "Start", true, why)}${note(step.prompt ? "Runs its prompt as a local agent session." : "No prompt: the agent gets the step title and the task.")}</div>`;
  }
  if (step.running) return `<p class="outbound-note">An agent is running this step.</p>`;
  if (f.apply) return `<div class="outbound-actions step-actions">${button("apply", "Apply", true)}${note("Adds it to the workspace's Claude settings.")}</div>`;
  if (step.move === "you-act") {
    if (f.run && readOnly(f.run)) return `<div class="outbound-actions step-actions">${button("run", "Approve and run", true, runConfigured ? "" : "Set steps.run in config/viewer.json")}${button("done", "Mark done")}</div>`;
    return `<div class="outbound-actions step-actions">${f.run ? button("copy-statement", "Copy statement", true) : ""}${button("done", "Mark done", !f.run)}</div>`;
  }
  if (step.move === "you-decide" && step.kind === "decision") return `<div class="outbound-actions step-actions">${button("note", "Decide…", true)}${button("done", "Mark decided")}${note("Say what you decided; an agent records it and carries it out.")}</div>`;
  return "";
}

function machineryHtml(step) {
  const f = step.machinery?.fields || {};
  return `${f.apply ? `<div class="step-run"><h5>Allow rule</h5>${codeHtml(f.apply)}</div>` : ""}${f.run ? `<div class="step-run"><h5>Statement${readOnly(f.run) ? " · read-only" : " · changes data"}</h5>${codeHtml(f.run, "sql")}${f.target ? `<p class="outbound-note">Runs as ${escapeHtml(f.target)}${f.undo ? ` · undo: <code>${escapeHtml(f.undo)}</code>` : ""}</p>` : ""}</div>` : ""}
    ${step.machinery ? `<p class="outbound-note"><a class="markdown-document-link" href="?path=${encodeURIComponent(step.machinery.path)}" data-document-path="${escapeHtml(step.machinery.path)}" data-document-anchor="">Open ${escapeHtml(step.machinery.path.split("/").pop())}</a></p>` : ""}`;
}

// A choice's options, an outbound draft's approval panel, or its machinery (and a note when it has no kind yet). Shared by
// the Steps inspector and the step dialog, which each say why the step is where it is in their own way.
export function stepBodyHtml(step) {
  const untyped = step.move === "unclassified" ? `<p class="outbound-note">No kind and no prompt: add <code>{kind, size}</code> to its line, or a prompt under Next actions with <code>Work item: ${escapeHtml(step.id)}</code>.</p>` : "";
  const body = step.options ? optionsHtml(step)
    : step.draft ? outboundPanel(step.draft, { showBody: true, showStep: false })
    : step.machinery ? machineryHtml(step)
    : "";
  const notes = step.notes?.length ? `<section class="step-notes"><h5>Waiting for an agent</h5><ul>${step.notes.map((note) => `<li><a class="markdown-document-link" href="?path=${encodeURIComponent(note.path)}" data-document-path="${escapeHtml(note.path)}" data-document-anchor="">${escapeHtml(note.title)}</a></li>`).join("")}</ul><p class="outbound-note">An agent records ${step.notes.length === 1 ? "this note" : "these notes"} and sets what comes next; the step stays open until then.</p></section>` : "";
  return `${notes}${untyped}${body}`;
}

// The inspector's priority line: the score (hover for its waterfall) and the task's P1/P2/P3, which writes `priority:` to the task file.
export const priorityHtml = (step) => noteLike(step) ? "" : `<div class="step-priority">${scoreHtml(step)}<span class="step-priority-why">Task priority</span>
  <span class="step-toggle" role="group" aria-label="Task priority" title="The whole task's priority: P1 raises every step in it, P3 lowers them">${["p1", "p2", "p3"].map((p) => `<button type="button" data-step-action="priority-${p}" aria-pressed="${(step.priority || "p2") === p}">${p.toUpperCase()}</button>`).join("")}</span></div>`;

export function stepInspectorHtml(step, extra = "", context = {}) {
  if (!step) return `<p class="task-detail-empty">Select a step to see its draft, prompt or options.</p>`;
  const head = `<header class="task-detail-head"><div class="task-detail-badges"><button class="task-list-id" type="button" data-task-path="${escapeHtml(step.path)}">${escapeHtml(step.task)}</button><span class="step-id">${escapeHtml(step.id)}</span>${pill(step)}</div>
      <span class="task-detail-buttons"><button class="task-detail-open" type="button" data-task-path="${escapeHtml(step.path)}">Workstream <span aria-hidden="true">→</span></button></span></header>
    <h3>${inlineMarkdown(step.title.split(" — ")[0], step.path)}</h3>
    <p class="task-detail-meta"><span>${escapeHtml(kindLabel(step.kind))}</span><span>${step.size ? `Size ${escapeHtml(step.size)}` : "No size yet"}</span><span>${escapeHtml(step.status)}</span><span>${escapeHtml(step.taskTitle)}</span></p>
    ${priorityHtml(step)}`;
  const friction = step.move === "you-act" && !step.draft ? `<p class="step-friction"><strong>Friction:</strong> ${escapeHtml(step.reason)}.${step.fix ? ` <strong>Fix:</strong> ${escapeHtml(step.fix)}.` : ""}</p>` : "";
  const blocked = step.move === "blocked" ? `<p class="outbound-note">Waits on ${escapeHtml(step.reason.replace(/^after /, ""))} in ${escapeHtml(step.task)}.</p>` : "";
  const prompt = step.prompt ? `<section class="task-detail-section"><h4>Prompt${step.actionTitle ? ` <span class="step-action-title">${escapeHtml(step.actionTitle)}</span>` : ""}</h4>${promptHtml(step.prompt, step.path)}</section>` : "";
  return `${head}${friction}${blocked}${extra}${stepBodyHtml(step)}${stepActionsHtml(step, context)}${prompt}`;
}
