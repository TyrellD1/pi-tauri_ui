// Small safe Markdown renderer and DOM-free presentation helpers.
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
export function inlineMd(src: string): string {
  // Tokens are recognized before escaping. Generated HTML is never re-parsed.
  const token = /!\[([^\]\n]*)\]\(([^\s)]+)(?:\s+"[^"\n]*")?\)|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:[^\s)]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let out = "", offset = 0;
  for (const m of src.matchAll(token)) {
    out += esc(src.slice(offset, m.index));
    if (m[2] !== undefined) out += `<img class="md-img" data-path="${esc(m[2])}" alt="${esc(m[1] || "image")}">`;
    else if (m[3]) out += `<code>${esc(m[3])}</code>`;
    else if (m[4]) out += `<a href="${esc(m[5])}" target="_blank" rel="noopener noreferrer">${esc(m[4])}</a>`;
    else if (m[6]) out += `<strong>${esc(m[6])}</strong>`;
    else out += `<em>${esc(m[7])}</em>`;
    offset = m.index! + m[0].length;
  }
  return out + esc(src.slice(offset));
}
function cells(row: string): string[] {
  const text = row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  const parts: string[] = []; let part = "", code = false;
  for (let i=0; i<text.length; i++) {
    const c = text[i];
    if (c === "\\" && text[i+1] === "|") { part += "|"; i++; }
    else if (c === "`") { code = !code; part += c; }
    else if (c === "|" && !code) { parts.push(part.trim()); part = ""; }
    else part += c;
  }
  parts.push(part.trim()); return parts;
}
export function renderMarkdown(src: string): string {
  const lines = src.split("\n"); let html = "", paragraph: string[] = [];
  const flush = () => { if (paragraph.length) html += `<p>${paragraph.map(inlineMd).join("<br/>")}</p>`; paragraph = []; };
  for (let i=0; i<lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```([^`]*)$/);
    if (fence) {
      flush(); const code: string[] = []; while (++i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i]);
      const lang = fence[1].trim() || "code";
      html += `<div class="codeblock"><div class="codeblock-head"><span>${esc(lang)}</span><button type="button" data-copy-code>Copy</button></div><pre><code>${esc(code.join("\n"))}</code></pre></div>`;
      continue;
    }
    const delim = lines[i+1] ? cells(lines[i+1]) : [];
    if (line.includes("|") && delim.length === cells(line).length && delim.every(d => /^:?-{2,}:?$/.test(d))) {
      flush(); const head = cells(line); i++;
      const style = (n: number) => delim[n].endsWith(":") ? delim[n].startsWith(":") ? "center" : "right" : "left";
      html += `<div class="tbl-wrap"><table><thead><tr>${head.map((c,n) => `<th style="text-align:${style(n)}">${inlineMd(c)}</th>`).join("")}</tr></thead><tbody>`;
      while (i+1 < lines.length && lines[i+1].includes("|") && lines[i+1].trim()) {
        const row = cells(lines[++i]); html += `<tr>${head.map((_,n) => `<td style="text-align:${style(n)}">${inlineMd(row[n] ?? "")}</td>`).join("")}</tr>`;
      }
      html += "</tbody></table></div>"; continue;
    }
    const h = line.match(/^(#{1,3}) (.*)$/);
    if (h) { flush(); html += `<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`; continue; }
    if (/^[-*] /.test(line) || /^\d+\. /.test(line)) {
      flush(); const ordered = /^\d/.test(line), re = ordered ? /^\d+\. / : /^[-*] /; const tag = ordered ? "ol" : "ul";
      html += `<${tag}>`; do { html += `<li>${inlineMd(lines[i].replace(re,""))}</li>`; i++; } while(i<lines.length && re.test(lines[i])); i--; html += `</${tag}>`; continue;
    }
    if (line.startsWith("> ")) { flush(); html += `<blockquote>${inlineMd(line.slice(2))}</blockquote>`; continue; }
    if (!line.trim()) flush(); else paragraph.push(line);
  }
  flush(); return html;
}

export interface ToolSummary {
  lead: string;
  rest: string;
}

/** Derive a compact human summary from a real tool name + arguments. */
export function toolSummary(name: string, args: unknown): ToolSummary {
  let obj: Record<string, unknown> = {};
  if (typeof args === "string") {
    try {
      obj = JSON.parse(args) as Record<string, unknown>;
    } catch {
      const s = args.trim();
      return { lead: name, rest: s.slice(0, 80) };
    }
  } else if (args && typeof args === "object") {
    obj = args as Record<string, unknown>;
  }
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = str(obj[k]);
      if (v) return v;
    }
    return "";
  };
  switch (name) {
    case "read":
    case "write":
    case "edit":
      return {
        lead: name === "read" ? "Read" : name === "write" ? "Write" : "Edit",
        rest: pick("path", "file", "filePath", "target") || "file",
      };
    case "bash":
      return { lead: "Run command", rest: pick("command", "cmd", "script") || "shell" };
    case "grep":
      return { lead: "Search", rest: pick("pattern", "query", "path") || "pattern" };
    case "find":
    case "ls":
      return { lead: name === "find" ? "Find" : "List", rest: pick("path", "dir", "pattern") || "files" };
    case "powershell":
      return { lead: "Run command", rest: pick("command", "cmd") || "shell" };
    default: {
      const first = pick("path", "file", "command", "pattern", "query", "url", "target");
      return { lead: name || "tool", rest: first.slice(0, 80) };
    }
  }
}

export interface Truncated {
  visible: string;
  totalLines: number;
  truncated: boolean;
}

/** Cap tool output at maxLines for initial display; full text stays available. */
export function truncateOutput(text: string, maxLines = 200): Truncated {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { visible: text, totalLines: lines.length, truncated: false };
  return {
    visible: lines.slice(0, maxLines).join("\n"),
    totalLines: lines.length,
    truncated: true,
  };
}

export function fmtRelative(mtime: number, now = Date.now()): string {
  const d = now - mtime;
  if (d < 0) return "just now";
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(mtime).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function queueSummary(steering: string[], followUp: string[]): string {
  const parts: string[] = [];
  for (const s of steering) parts.push(`steering: ${s.slice(0, 80)}`);
  for (const f of followUp) parts.push(`follow-up: ${f.slice(0, 80)}`);
  return parts.join(" · ");
}

export type ActivityKind =
  | "idle"
  | "thinking"
  | "running"
  | "waiting"
  | "stopping"
  | "compacting"
  | "switching";

export function activityLabel(kind: ActivityKind, toolName = ""): string {
  switch (kind) {
    case "thinking":
      return "Thinking…";
    case "running":
      return toolName ? `Running ${toolName}…` : "Running command…";
    case "waiting":
      return "Waiting for your input";
    case "stopping":
      return "Stopping…";
    case "compacting":
      return "Compacting…";
    case "switching":
      return "Switching…";
    default:
      return "Ready";
  }
}

/** Send-button enablement per the interaction contract. */
export function canSend(args: { streaming: boolean; stopping: boolean; hasText: boolean; hasImages: boolean }): boolean {
  if (args.stopping) return false;
  return args.hasText || args.hasImages;
}

/**
 * Normalize a Tauri command result against the RPC response envelope.
 * Returns the error string when the envelope reports success:false, else null.
 * Transport throws still surface as exceptions; this covers negative envelopes
 * that otherwise resolve as "successful" invoke calls and get ignored.
 */
export function envelopeError(v: unknown): string | null {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.success === false) {
      const e = o.error;
      return typeof e === "string" && e ? e : "request failed";
    }
  }
  return null;
}
