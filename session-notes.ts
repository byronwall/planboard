import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// The user's notes on an agent chat session, from the session overlay: one Markdown file per session under
// reference/session-notes/, readable and hand-editable. A note sits on one tool call (by the call's ID in the log) or on
// the whole session, and quotes the call's first line so the file reads on its own. Anything that doesn't parse as a
// note is kept verbatim.
export type SessionNote = { id: string; call: string; name: string; time: string; at: string; quote: string; body: string };
type Entry = SessionNote | { raw: string };

export const NOTES_DIR = "reference/session-notes";
const HEAD = /^### (?:`(.+?)` · (.+?) · call (\S+)|Whole session)$/;
const META = /^- id: (\w+) · at: (.+)$/;
const isNote = (entry: Entry): entry is SessionNote => !("raw" in entry);

export const notesPath = (key: string) => {
  if (!/^(?:claude|codex):[\w-]+$/.test(key)) throw new Error("Not a session key.");
  return `${NOTES_DIR}/${key.replace(":", "-")}.md`;
};

export function parseSessionNotes(text: string) {
  const [preamble, ...chunks] = text.split(/^(?=### )/m);
  const entries: Entry[] = chunks.map((chunk) => {
    const lines = chunk.replace(/\s+$/, "").split("\n");
    const head = HEAD.exec(lines[0]);
    const meta = META.exec(lines[1] || "");
    if (!head || !meta) return { raw: chunk };
    let index = 2;
    while (lines[index] === "") index++;
    const quote: string[] = [];
    while (lines[index]?.startsWith(">")) quote.push(lines[index++].replace(/^> ?/, ""));
    return { id: meta[1], at: meta[2], name: head[1] || "", time: head[2] || "", call: head[3] || "", quote: quote.join("\n"), body: lines.slice(index).join("\n").trim() };
  });
  return { preamble, entries };
}

function formatNote(note: SessionNote) {
  const head = note.call ? `### \`${note.name}\` · ${note.time} · call ${note.call}` : "### Whole session";
  const quote = note.quote ? `${note.quote.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}\n\n` : "";
  return `${head}\n- id: ${note.id} · at: ${note.at}\n\n${quote}${note.body}\n\n`;
}

const stamp = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
const oneLine = (text: unknown) => String(text || "").replace(/[\r\n`]/g, " ").trim();

export function createSessionNotes(root: string) {
  const load = async (key: string) => parseSessionNotes(await readFile(join(root, notesPath(key)), "utf8").catch(() => ""));

  async function list(key: string) {
    const { entries } = await load(key);
    return { path: notesPath(key), notes: entries.filter(isNote) };
  }

  type Change = { key: string; op: "add" | "update" | "delete"; id?: string; title?: string; log?: string; note?: Partial<SessionNote> };
  async function change({ key, op, id, title, log, note = {} }: Change) {
    let { preamble, entries } = await load(key);
    const body = String(note.body || "").replace(/\r/g, "").trim();
    if (op === "add") {
      if (!body) throw new Error("A note needs some text.");
      const call = oneLine(note.call);
      if (call && !/^\S+$/.test(call)) throw new Error("A call ID has no spaces.");
      if (!preamble.trim()) preamble = `# Notes on ${oneLine(title) || key}\n\nSession \`${key}\`${log ? `, log \`${log}\`` : ""}. Notes from Planboard's session overlay, each on one tool call or the whole session.\n`;
      entries.push({ id: Math.random().toString(36).slice(2, 8), call, name: oneLine(note.name) || "tool", time: oneLine(note.time),
        at: stamp(), quote: String(note.quote || "").replace(/\r/g, "").slice(0, 400), body });
    } else {
      const target = entries.find((entry) => isNote(entry) && entry.id === id) as SessionNote | undefined;
      if (!target) throw new Error("That note is gone; reload the overlay.");
      if (op === "delete") entries = entries.filter((entry) => entry !== target);
      else if (body) target.body = body;
    }
    const path = join(root, notesPath(key));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${preamble.replace(/\s+$/, "")}\n\n${entries.map((entry) => isNote(entry) ? formatNote(entry) : `${entry.raw.replace(/\s+$/, "")}\n\n`).join("")}`.replace(/\n+$/, "\n"));
    return list(key);
  }

  return { list, change };
}
