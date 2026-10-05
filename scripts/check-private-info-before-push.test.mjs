import assert from "node:assert/strict";
import test from "node:test";

import {
  formatReport,
  parseAddedLines,
  resolveDenylistStrings,
  runCheck,
  scanAddedLines,
} from "./check-private-info-before-push.mjs";

const SAMPLE_DIFF = [
  "diff --git a/foo.ts b/foo.ts",
  "index 111..222 100644",
  "--- a/foo.ts",
  "+++ b/foo.ts",
  "@@ -1,2 +1,4 @@",
  " const a = 1;",
  "-const old = 2;",
  '+const key = "AKIAABCDEFGHIJKLMNOP";',
  "+// see TIE-999 for context",
  "+const clean = 3;",
].join("\n");

test("parseAddedLines only captures added lines with correct line numbers", () => {
  const entries = parseAddedLines(SAMPLE_DIFF);
  assert.deepEqual(
    entries.map((e) => [e.file, e.line, e.text]),
    [
      ["foo.ts", 1, 'const key = "AKIAABCDEFGHIJKLMNOP";'],
      ["foo.ts", 2, "// see TIE-999 for context"],
      ["foo.ts", 3, "const clean = 3;"],
    ],
  );
});

test("scanAddedLines flags a seeded AWS-shaped key", () => {
  const entries = [{ file: "foo.ts", line: 1, text: 'const key = "AKIAABCDEFGHIJKLMNOP";' }];
  const hits = scanAddedLines(entries, []);
  assert.ok(hits.some((h) => h.category === "secret" && h.pattern === "aws-access-key-id"));
});

test("scanAddedLines flags an internal ticket reference", () => {
  const entries = [{ file: "foo.ts", line: 1, text: "// see TIE-999 for context" }];
  const hits = scanAddedLines(entries, []);
  assert.ok(hits.some((h) => h.category === "ticket-ref" && h.snippet === "TIE-999"));
});

test("scanAddedLines flags a denylisted local path", () => {
  const entries = [{ file: "foo.ts", line: 1, text: "// lives at /Users/tieredit/.paperclip" }];
  const hits = scanAddedLines(entries, ["/Users/tieredit"]);
  assert.ok(hits.some((h) => h.category === "instance-identifying" && h.snippet === "/Users/tieredit"));
});

test("scanAddedLines passes a clean line", () => {
  const entries = [{ file: "foo.ts", line: 1, text: "const clean = 3;" }];
  const hits = scanAddedLines(entries, ["/Users/tieredit"]);
  assert.deepEqual(hits, []);
});

test("resolveDenylistStrings pulls live PAPERCLIP_* values, not hardcoded guesses", () => {
  const env = { PAPERCLIP_COMPANY_ID: "company-abc-123", UNRELATED: "ignored" };
  const strings = resolveDenylistStrings(env, { homedir: () => "/Users/someone" });
  assert.ok(strings.includes("company-abc-123"));
  assert.ok(!strings.includes("ignored"));
  assert.ok(strings.includes("/Users/someone"));
  assert.ok(strings.includes("Ada"));
});

test("resolveDenylistStrings always includes the real machine path even when the sandbox HOME differs", () => {
  // A run-scoped sandbox can report a temp dir as $HOME/os.homedir() instead
  // of the operator's actual machine home — the known real path must still
  // be present so paths like /Users/tieredit/... are always caught.
  const strings = resolveDenylistStrings(
    { HOME: "/var/folders/sandbox-tmp" },
    { homedir: () => "/var/folders/sandbox-tmp" },
  );
  assert.ok(strings.includes("/Users/tieredit"));
});

test("formatReport redacts a live secret/env value instead of echoing it in full", () => {
  const report = formatReport([
    { file: "foo.ts", line: 1, category: "secret", pattern: "aws-access-key-id", snippet: "AKIAABCDEFGHIJKLMNOP" },
  ]);
  assert.ok(!report.includes("AKIAABCDEFGHIJKLMNOP"));
  assert.ok(report.includes("redacted"));
});

test("formatReport prints ticket refs and instance links in full (not secret values)", () => {
  const report = formatReport([
    { file: "foo.ts", line: 1, category: "ticket-ref", pattern: "internal-ticket-id", snippet: "TIE-999" },
  ]);
  assert.ok(report.includes("TIE-999"));
});

test("runCheck exits 1 and reports hits on a dirty diff", () => {
  const logs = [];
  const errors = [];
  const exitCode = runCheck({
    base: "origin/master",
    exec: () => SAMPLE_DIFF,
    env: {},
    osModule: { homedir: () => "/Users/tieredit" },
    log: (msg) => logs.push(msg),
    error: (msg) => errors.push(msg),
  });
  assert.equal(exitCode, 1);
  // The secret itself must never appear in the report output (see
  // formatReport's redaction test) — only the ticket ref, which is
  // structural rather than a credential, prints in full.
  assert.ok(!errors.join("\n").includes("AKIAABCDEFGHIJKLMNOP"));
  assert.ok(errors.join("\n").includes("TIE-999"));
});

test("runCheck exits 0 on a clean diff", () => {
  const cleanDiff = [
    "diff --git a/foo.ts b/foo.ts",
    "--- a/foo.ts",
    "+++ b/foo.ts",
    "@@ -1,0 +1,1 @@",
    "+const clean = 3;",
  ].join("\n");
  const logs = [];
  const exitCode = runCheck({
    base: "origin/master",
    exec: () => cleanDiff,
    env: {},
    osModule: { homedir: () => "/Users/tieredit" },
    log: (msg) => logs.push(msg),
    error: () => {},
  });
  assert.equal(exitCode, 0);
});
