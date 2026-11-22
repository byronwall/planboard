// Shell commands from agent logs, made readable: one statement per line and light syntax colors.
//
// Agents write long one-liners (`cd x && for d in …; do …; done; tail …`). `shellLines` breaks one at its top-level
// `;`, `&&`, `||` and `|` (never inside quotes, `$( )` or parentheses) and indents loop and if bodies, so the result
// still runs the same. `shellHtml` colors commands, flags, strings, variables, paths and operators; a `cd` line is dimmed,
// since it only sets the folder for what follows. Commands that already span lines keep their own breaks.
import { escapeHtml } from "./markdown.js";

const KEYWORDS = new Set(["for", "in", "do", "done", "if", "then", "elif", "else", "fi", "while", "until", "case", "esac", "function", "time"]);
const OPENS = new Set(["do", "then"]);
const CLOSES = new Set(["done", "fi", "esac"]);
const RESETS = new Set([";", "&&", "||", "|", "(", "$(", "{", "\n", "&"]);

// Tokens: space, newline, op, str, comment, word. Quotes, `$( )` and backticks stay inside one token.
export function lex(text) {
  const out = [];
  let i = 0;
  const push = (kind, value) => out.push({ kind, text: value });
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") { push("newline", c); i++; continue; }
    if (c === " " || c === "\t") { let j = i; while (text[j] === " " || text[j] === "\t") j++; push("space", text.slice(i, j)); i = j; continue; }
    if (c === "#" && (!out.length || /space|newline|op/.test(out.at(-1).kind))) { let j = text.indexOf("\n", i); if (j < 0) j = text.length; push("comment", text.slice(i, j)); i = j; continue; }
    const op = /^(?:&&|\|\||;;|2>&1|&>|\d?>>|\d?>|<<<|<<|<|\||;|&|\(|\)|\{|\})/.exec(text.slice(i))?.[0];
    if (op && !(op === "{" || op === "}") || (op && /[\s;]/.test(text[i + 1] ?? " ") && /^[\s;]?$/.test(text[i - 1] ?? ""))) { push("op", op); i += op.length; continue; }
    // A word runs to the next space or operator, carrying any quoted or $( ) parts with it.
    let j = i;
    let quoted = false;
    while (j < text.length && !/[\s;|&<>()]/.test(text[j])) {
      const q = text[j];
      if (q === "'" || q === '"' || q === "`") {
        quoted = true;
        let k = j + 1;
        while (k < text.length && text[k] !== q) k += q !== "'" && text[k] === "\\" ? 2 : 1;
        j = k + 1;
      } else if (q === "$" && text[j + 1] === "(") {
        let depth = 0, k = j + 1;
        for (; k < text.length; k++) { if (text[k] === "(") depth++; else if (text[k] === ")" && --depth === 0) break; }
        j = k + 1;
      } else if (q === "\\") j += 2;
      else j++;
    }
    if (j === i) { push("op", c); i++; continue; }
    push(quoted && /^['"`]/.test(text[i]) ? "str" : "word", text.slice(i, j));
    i = j;
  }
  return out;
}

// One statement per line. Operators that join lines stay at the end of the line; `;` becomes the line break itself.
export function shellLines(text) {
  const source = String(text ?? "").trim();
  if (!source || source.includes("\n") || source.includes("<<")) return source;
  const lines = [];
  let line = "";
  let depth = 0;
  let pending = 0;
  let paren = 0;
  let first = true;
  const flush = (extra = 0) => {
    const body = line.trim();
    if (body) lines.push("  ".repeat(Math.max(0, depth + pending)) + body);
    line = "";
    pending = extra;
    first = true;
  };
  for (const token of lex(source)) {
    if (token.kind === "op" && paren === 0 && (token.text === ";" || token.text === "&&" || token.text === "||" || token.text === "|")) {
      if (token.text === ";") flush(0);
      else { line = `${line.trimEnd()} ${token.text}`; flush(1); }
      continue;
    }
    if (token.kind === "op" && token.text === "(") paren++;
    if (token.kind === "op" && token.text === ")") paren = Math.max(0, paren - 1);
    if (token.kind === "word" && first && paren === 0) {
      if (CLOSES.has(token.text)) { depth = Math.max(0, depth - 1); pending = 0; }
      if (OPENS.has(token.text) || token.text === "else") {
        // `do cmd` and `then cmd`: put the keyword on its own line and indent what follows.
        if (token.text === "else") depth = Math.max(0, depth - 1);
        line = token.text;
        flush(0);
        depth++;
        continue;
      }
    }
    if (token.kind !== "space") first = false;
    line += token.text;
  }
  flush();
  return lines.join("\n");
}

// The programs a command runs, in order and once each, leaving out `cd` and shell keywords: "git head tail".
// A heredoc's body is data, not commands: `cat <<'EOF'` keeps its first line and drops the body through the delimiter.
const HEREDOC = /(<<-?\s*(['"]?)([\w.-]+)\2)([^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g;
export const withoutHeredocs = (text) => String(text ?? "").replace(HEREDOC, "$1$4");

export function commandNames(text) {
  const names = [];
  let start = true;
  for (const token of lex(withoutHeredocs(text))) {
    if (token.kind === "space") continue;
    if (token.kind === "op" || token.kind === "newline") { start = RESETS.has(token.text) || start; continue; }
    if (start && token.kind === "word") {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text) || /^(?:do|then|else|elif|if|while|until|time|!)$/.test(token.text)) continue;
      if (!KEYWORDS.has(token.text) && token.text !== "cd" && !token.text.startsWith("[")) names.push(token.text.split("/").at(-1));
    }
    start = false;
  }
  return [...new Set(names)];
}

// Colored HTML for a command, one `<span class="sh-line">` per line.
export function shellHtml(text) {
  // Heredoc bodies stay plain text; everything else is colored line by line.
  const out = [];
  let shell = [];
  let delimiter = "";
  const flush = () => { if (shell.length) out.push(colorLines(shell.join("\n"))); shell = []; };
  for (const line of String(text ?? "").split("\n")) {
    if (delimiter) {
      out.push(`<span class="sh-line sh-heredoc">${escapeHtml(line) || " "}</span>`);
      if (line.trim() === delimiter) delimiter = "";
      continue;
    }
    shell.push(line);
    const open = /<<-?\s*(['"]?)([\w.-]+)\1/.exec(line);
    if (open) { flush(); delimiter = open[2]; }
  }
  flush();
  return out.join("");
}

function colorLines(text) {
  const tokens = lex(text);
  const lines = [[]];
  for (const token of tokens) token.kind === "newline" ? lines.push([]) : lines.at(-1).push(token);
  return lines.map((line) => {
    let command = true;
    let cd = false;
    const html = line.map((token) => {
      const value = escapeHtml(token.text);
      if (token.kind === "space") return value;
      if (token.kind === "op") { if (RESETS.has(token.text)) command = true; return `<span class="sh-op">${value}</span>`; }
      if (token.kind === "comment") return `<span class="sh-comment">${value}</span>`;
      if (token.kind === "str") { command = false; return `<span class="sh-str">${value}</span>`; }
      if (token.text === "in" && line.find((other) => other.kind === "word")?.text === "for") return `<span class="sh-kw">${value}</span>`;
      if (KEYWORDS.has(token.text) && command) { command = !["in"].includes(token.text) && token.text !== "for"; return `<span class="sh-kw">${value}</span>`; }
      if (command && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text)) return `<span class="sh-var">${value}</span>`;
      if (command) {
        command = false;
        if (token.text === "cd" && !cd) cd = line.filter((other) => other.kind !== "space").length <= 3;
        return `<span class="sh-cmd">${value}</span>`;
      }
      if (/^-/.test(token.text)) return `<span class="sh-flag">${value}</span>`;
      if (/^\$/.test(token.text)) return `<span class="sh-var">${value}</span>`;
      if (/['"]/.test(token.text)) return value.replace(/(&#39;|&quot;|')(.*?)\1/g, '<span class="sh-str">$&</span>');
      if (/^[~./]|\//.test(token.text)) return `<span class="sh-path">${value}</span>`;
      return value;
    }).join("");
    return `<span class="sh-line${cd ? " is-cd" : ""}">${html || " "}</span>`;
  }).join("");
}
