// Focused regression checks for changed behavioral logic (astra steer A).
// Bundles src/logic.ts with esbuild, imports it, and asserts the contract.
// Run: node scripts/regression-check.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "pi-logic-"));
const out = join(dir, "logic.mjs");
try {
  execFileSync("node_modules/.bin/esbuild", ["src/logic.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${out}`], {
    stdio: "pipe",
  });
} catch (e) {
  console.error("esbuild bundle failed:", e.stdout?.toString(), e.stderr?.toString());
  process.exit(1);
}
const logic = await import(pathToFileURL(out).href);

let pass = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`ok - ${name}`);
  } else {
    console.error(`FAIL - ${name} ${extra}`);
    process.exitCode = 1;
  }
}

// 1. markdown: real heading hierarchy + codeblock surface with copy + language
const md = logic.renderMarkdown("# T\n\n## U\n\n### V\n\n```ts\nconst a = 1;\n```\n\n- one\n- two");
check("h1 20px hierarchy", md.includes("<h1>T</h1>"), md.slice(0, 200));
check("h2 hierarchy", md.includes("<h2>U</h2>"));
check("h3 hierarchy", md.includes("<h3>V</h3>"));
check("codeblock surface", md.includes('class="codeblock"'));
check("codeblock language label", md.includes(">ts<"));
check("codeblock copy control", md.includes("data-copy-code"));
check("list rendering", md.includes("<ul>") && md.includes("<li>one</li>"));

// 2. tool summaries derive from real names/arguments
check("read summary", JSON.stringify(logic.toolSummary("read", { path: "src/main.ts" })) === JSON.stringify({ lead: "Read", rest: "src/main.ts" }));
check("bash summary", logic.toolSummary("bash", { command: "npm run build" }).lead === "Run command");
check("bash keeps command", logic.toolSummary("bash", { command: "npm run build" }).rest === "npm run build");
check("grep summary", logic.toolSummary("grep", { pattern: "foo", path: "src" }).lead === "Search");
check("unknown falls back honestly", logic.toolSummary("mystery", {}).lead === "mystery");
check("string args handled", logic.toolSummary("bash", "npm test").rest === "npm test");

// 3. tool output truncation: 200 lines initially, full text retained
const big = Array.from({ length: 260 }, (_, i) => `line ${i}`).join("\n");
const t = logic.truncateOutput(big);
check("truncates at 200 lines", t.visible.split("\n").length === 200);
check("reports total lines", t.totalLines === 260);
check("flags truncation", t.truncated === true);
const small = logic.truncateOutput("a\nb");
check("short output untouched", small.truncated === false && small.visible === "a\nb");

// 4. queue labels distinguish steering vs follow-up
const q = logic.queueSummary(["steer now"], ["later please"]);
check("queue shows steering", q.includes("steering: steer now"));
check("queue shows follow-up", q.includes("follow-up: later please"));

// 5. send contract: idle empty disabled, attachment-only sendable, stopping blocks
check("idle empty cannot send", logic.canSend({ streaming: false, stopping: false, hasText: false, hasImages: false }) === false);
check("idle text can send", logic.canSend({ streaming: false, stopping: false, hasText: true, hasImages: false }) === true);
check("attachment-only sendable", logic.canSend({ streaming: false, stopping: false, hasText: false, hasImages: true }) === true);
check("stopping blocks send", logic.canSend({ streaming: true, stopping: true, hasText: true, hasImages: false }) === false);
check("running draft can steer", logic.canSend({ streaming: true, stopping: false, hasText: true, hasImages: false }) === true);

// 6. single activity status labels driven by events
check("thinking label", logic.activityLabel("thinking") === "Thinking…");
check("running names tool", logic.activityLabel("running", "bash") === "Running bash…");
check("waiting label", logic.activityLabel("waiting") === "Waiting for your input");
check("stopping label", logic.activityLabel("stopping") === "Stopping…");
check("idle label", logic.activityLabel("idle") === "Ready");

// 7. relative dates subdued, no monospace timestamps
check("just now", logic.fmtRelative(Date.now() - 10_000) === "just now");
check("minutes", logic.fmtRelative(Date.now() - 5 * 60_000) === "5m ago");
check("hours", logic.fmtRelative(Date.now() - 3 * 3600_000) === "3h ago");

console.log(`\n${pass} checks passed${process.exitCode ? " (with failures)" : ""}`);
rmSync(dir, { recursive: true, force: true });
