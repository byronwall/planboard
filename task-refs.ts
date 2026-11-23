// `planboard refs [TASK-NNNN …] [--all]`: what each task's canonical references (`tracks:`, `resolves:`, step `(pr:)`
// tags) are missing, for an agent to fix. It reads only local files: the task, the PR lists the Code view cached in
// tmp/code-cache.json, and the titles in tmp/link-metadata.json, so it runs offline and never calls gh or acli.
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inlineMarkdown } from "./public/markdown.js";
import { metadataKey } from "./public/dock.js";
import { referenceConfig } from "./public/config.js";
import { taskFile } from "./public/layout.js";
import { parseTaskDocument, ROOT } from "./server.ts";

export type CachedPr = { slug: string; number: number; title: string; branch: string; state: string };
export type Finding = { task: string; problem: string; fix: string };

const prKey = (slug: string, number: number) => `github:${slug}#${number}`.toLowerCase();
const isPr = (key: string) => /^github:[^@]+#\d+$/.test(key);
const isIssue = (key: string) => /^(jira|linear):/.test(key);
// How a ref is written back into front matter: `repo#N` for a configured repository, else the PR's URL.
function prRef(slug: string, number: number) {
  const { owner, repos, defaultRepo } = referenceConfig();
  const [prOwner, repo] = slug.split("/");
  const name = prOwner.toLowerCase() === (owner || "").toLowerCase() && repos[repo.toLowerCase()];
  return name ? (name === defaultRepo ? `#${number}` : `${name}#${number}`) : `https://github.com/${slug}/pull/${number}`;
}

// Every PR and tracker issue the task's text links, in order of first mention, with how often it is named.
function mentioned(body: string, path: string) {
  const counts = new Map<string, number>();
  for (const line of body.split("\n")) for (const [, raw] of inlineMarkdown(line, path).matchAll(/href="(https:[^"]+)"/g)) {
    const key = metadataKey(raw.replaceAll("&amp;", "&")).toLowerCase();
    if (isPr(key) || isIssue(key)) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// What one task's canonical references are missing. `prs` are the cached PR lists, `titles` the cached link titles.
export function referenceFindings(path: string, markdown: string, prs: CachedPr[], titles: Record<string, { title?: string }>): Finding[] {
  const { task, body } = parseTaskDocument(path, markdown);
  const refs = task.refs || [];
  const findings: Finding[] = [];
  const add = (problem: string, fix: string) => findings.push({ task: task.id, problem, fix });
  for (const ref of refs.filter((entry) => !entry.href)) add(`${ref.role} names “${ref.ref}”, which the viewer can't link`, "write #123, repo#123, a tracker key from config/viewer.json trackers, or a full URL");
  const listed = new Set(refs.map((ref) => ref.key.toLowerCase()));
  const tracked = refs.filter((ref) => ref.role === "tracks" && isIssue(ref.key.toLowerCase())).map((ref) => ref.key.replace(/^\w+:/, ""));
  const named = mentioned(body, path);
  const resolves = refs.some((ref) => ref.role === "resolves");

  const none = new Set(task.noRefs || []);
  if (!refs.some((ref) => ref.role === "tracks") && !none.has("tracks")) {
    const issues = [...named].filter(([key]) => isIssue(key)).sort((a, b) => b[1] - a[1]);
    if (issues.length) add(`no tracks: line, but the text names ${issues.map(([key]) => key.replace(/^\w+:/, "").toUpperCase()).join(", ")}`, `add the one issue that tracks this task, e.g. tracks: [${issues[0][0].replace(/^\w+:/, "").toUpperCase()}], or tracks: [] when none does`);
  }
  // PRs whose title or branch carries a tracked key are the strongest signal: GitHub and Jira link them the same way.
  const carrying = new Map<string, CachedPr>();
  for (const pr of prs) {
    const key = prKey(pr.slug, pr.number);
    if (listed.has(key)) continue;
    const text = `${pr.title} ${pr.branch} ${titles[key]?.title || ""}`;
    if (tracked.some((issue) => new RegExp(`(^|[^A-Za-z0-9])${issue}([^0-9]|$)`, "i").test(text))) carrying.set(key, pr);
  }
  for (const [key] of named) {
    if (!isPr(key) || listed.has(key) || carrying.has(key)) continue;
    const title = titles[key]?.title || Object.entries(titles).find(([other]) => other.toLowerCase() === key)?.[1].title || "";
    if (tracked.some((issue) => new RegExp(`(^|[^A-Za-z0-9])${issue}([^0-9]|$)`, "i").test(title))) {
      const [, slug, number] = key.match(/^github:(.+)#(\d+)$/)!;
      carrying.set(key, { slug, number: Number(number), title, branch: "", state: "" });
    }
  }
  // `resolves: []` says no PR resolves this task, so neither a carried key nor a linked PR asks for one.
  if (none.has("resolves")) return findings;
  for (const pr of carrying.values()) add(`${prRef(pr.slug, pr.number)} “${pr.title}”${pr.state ? ` (${pr.state.toLowerCase()})` : ""} carries ${tracked.join(", ")} but isn't listed`, `add ${prRef(pr.slug, pr.number)} to resolves:, or tag the step it carries with (pr: ${prRef(pr.slug, pr.number)}); leave it out only if it is a reference, not part of the fix (resolves: [] when no PR resolves the task)`);
  if (!resolves && !carrying.size) {
    const linked = [...named].filter(([key]) => isPr(key)).map(([key]) => key.match(/^github:(.+)#(\d+)$/)!);
    if (linked.length) add(`no resolves: line, but the text links ${linked.map(([, slug, n]) => prRef(slug, Number(n))).join(", ")}`, "list the PRs that resolve this task in resolves: (or tag their steps with (pr: …)); PRs that are only references stay out, and resolves: [] says none does");
  }
  return findings;
}

// The PR lists the Code view keeps on disk: open and recently closed PRs per repository, and each repository's history.
async function cachedPrs(root: string): Promise<CachedPr[]> {
  const saved = await readFile(join(root, "tmp", "code-cache.json"), "utf8").then(JSON.parse).catch(() => ({}));
  const found = new Map<string, CachedPr>();
  const keep = (slug: string, pr: any, state = "") => slug && pr?.number && !found.has(prKey(slug, pr.number)) && found.set(prKey(slug, pr.number), { slug, number: pr.number, title: pr.title || "", branch: pr.branch || "", state: pr.state || state });
  for (const entry of Object.values<any>(saved.openPrs || {})) {
    for (const pr of entry.prs || []) keep(pr.slug, pr, pr.draft ? "draft" : "open");
    for (const pr of entry.done || []) keep(pr.slug, pr);
  }
  for (const [slug, entry] of Object.entries<any>(saved.prHistory || {})) for (const pr of entry.prs || []) keep(slug, pr);
  return [...found.values()];
}

export async function checkReferences(args: string[], root = ROOT) {
  const all = args.includes("--all");
  const ids = args.filter((arg) => /^TASK-\d{4}$/i.test(arg)).map((arg) => arg.toUpperCase());
  if (args.some((arg) => arg !== "--all" && !/^TASK-\d{4}$/i.test(arg))) throw new Error("Usage: planboard refs [TASK-NNNN …] [--all]");
  const folders = ids.length ? ids : (await readdir(join(root, "tasks")).catch(() => [])).filter((name) => /^TASK-\d{4}$/.test(name)).sort();
  const [prs, titles] = await Promise.all([cachedPrs(root), readFile(join(root, "tmp", "link-metadata.json"), "utf8").then(JSON.parse).catch(() => ({}))]);
  const findings: Finding[] = [];
  for (const id of folders) {
    const path = taskFile(id);
    const markdown = await readFile(join(root, path), "utf8").catch(() => null);
    if (markdown === null) { if (ids.length) findings.push({ task: id, problem: `${path} does not exist`, fix: "" }); continue; }
    try {
      const { task } = parseTaskDocument(path, markdown);
      // Settled tasks are history; a named task or --all checks them too.
      if (!ids.length && !all && ["completed", "deferred"].includes(task.status)) continue;
      findings.push(...referenceFindings(path, markdown, prs, titles));
    } catch (error) {
      findings.push({ task: id, problem: error instanceof Error ? error.message : String(error), fix: "" });
    }
  }
  return { tasks: folders.length, findings, cached: prs.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { tasks, findings, cached } = await checkReferences(process.argv.slice(2));
    for (const finding of findings) console.log(`${finding.task}  ${finding.problem}${finding.fix ? `\n           → ${finding.fix}` : ""}`);
    if (!cached) console.log("note   no PR lists in tmp/code-cache.json yet (open the Code view once), so only PRs the task text links were checked");
    if (!findings.length) console.log(`ok     ${tasks} tasks, canonical references complete`);
    process.exitCode = findings.length ? 1 : 0;
  } catch (error) {
    console.error(`error  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
