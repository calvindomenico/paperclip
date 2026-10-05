#!/usr/bin/env node
/**
 * check-private-info-before-push.mjs
 *
 * Gate for our private-staging fork workflow (see CONTRIBUTING.md "No
 * Internal Issue References" and "Branch Naming"): before a branch is pushed
 * to the fork, and again before a PR is opened upstream, nothing from our
 * instance should leak into the diff. Checks the diff against a base ref for:
 *
 *   1. Secret-shaped strings (API keys, tokens, private key blocks) — a
 *      baseline regex net. This is NOT a substitute for a real scanner; run
 *      the GitHub app's `run-secret-scanning` tool against the pushed branch
 *      or PR as the authoritative second pass.
 *   2. Internal ticket references (`TIE-123`, `PAP-224`, any `{PREFIX}-{NUMBER}`). (paperclip:allow-private-info: doc example)
 *   3. Company/instance-identifying strings: agent names, this machine's
 *      local paths, and live `PAPERCLIP_*` env var values (read from the
 *      environment, not hardcoded).
 *
 * Usage:
 *   node scripts/check-private-info-before-push.mjs [--base <ref>]
 *
 * Exits non-zero with a file:line report per hit. Exits 0 on a clean diff.
 */

import { execSync } from "node:child_process";
import os from "node:os";
import process from "node:process";

const DEFAULT_BASE = "origin/master";

const SECRET_PATTERNS = [
  { name: "aws-access-key-id", re: /AKIA[0-9A-Z]{16}/ },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "github-fine-grained-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "stripe-live-key", re: /\bsk_live_[A-Za-z0-9]{10,}\b/ },
  { name: "private-key-block", re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "generic-secret-assignment", re: /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{16,}["']/i },
];

const TICKET_REF_RE = /\b[A-Z]{2,10}-\d{1,6}\b/;

// Opt-in escape hatch, mirroring check-no-git-push.mjs's ALLOW_MARKER: this
// script's own source and tests legitimately contain literal examples of
// what it detects (sample ticket ids, denylisted names, a fake AWS key for
// the test fixture). A same-line marker comment suppresses the match instead
// of forcing those lines to be obfuscated into something less readable.
export const ALLOW_MARKER = "paperclip:allow-private-info";

const INTERNAL_LINK_RES = [
  { name: "instance-ui-path", re: /\/[A-Z]{2,10}\/(issues|agents|projects|approvals)\// },
  { name: "agent-uri", re: /agent:\/\// },
  { name: "document-deeplink", re: /#document-[a-z0-9-]+/i },
];

function uniqueNonEmpty(values) {
  return Array.from(new Set(values.map((v) => (v ?? "").trim()).filter(Boolean)));
}

export function resolveDenylistStrings(env = process.env, osModule = os) {
  const candidates = [];

  // Live PAPERCLIP_* values — read dynamically, never hardcoded, so this
  // tracks whatever this environment actually injects.
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("PAPERCLIP_") && value && value.length >= 4) {
      candidates.push(value);
    }
  }

  // This machine's local paths. os.homedir()/$HOME reflect the *current*
  // process's sandbox, which can differ from the real operator machine
  // (e.g. a run-scoped sandbox HOME instead of the actual operator homedir)
  // — so the real machine path is also listed explicitly rather than
  // relying on the dynamic value alone.
  try {
    candidates.push(osModule.homedir());
  } catch {
    // Some environments do not expose homedir(); env fallback below covers it.
  }
  candidates.push(env.HOME, env.USERPROFILE, "/Users/tieredit"); // paperclip:allow-private-info: literal denylist entry, not a leak

  // Known company/agent identifiers that must never reach a public diff.
  candidates.push(
    "Tiered Integration", // paperclip:allow-private-info: literal denylist entry, not a leak
    "Ada", // paperclip:allow-private-info: literal denylist entry, not a leak
    "Hal", // paperclip:allow-private-info: literal denylist entry, not a leak
    "Volt", // paperclip:allow-private-info: literal denylist entry, not a leak
    "Zed", // paperclip:allow-private-info: literal denylist entry, not a leak
    "Mason", // paperclip:allow-private-info: literal denylist entry, not a leak
    "local-board", // paperclip:allow-private-info: literal denylist entry, not a leak
  );

  return uniqueNonEmpty(candidates);
}

function runGitDiff(base, exec) {
  return exec(`git diff --unified=0 --no-color "${base}...HEAD"`, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
}

/**
 * Parses unified diff output into { file, line, text } entries for added
 * lines only — we only care about what this branch is about to introduce,
 * not pre-existing content on the base ref.
 */
export function parseAddedLines(diffText) {
  const entries = [];
  let currentFile = null;
  let newLineNumber = null;

  for (const rawLine of diffText.split("\n")) {
    if (rawLine.startsWith("+++ ")) {
      const match = rawLine.match(/^\+\+\+ (?:b\/)?(.+)$/);
      currentFile = match ? match[1] : rawLine.slice(4);
      continue;
    }
    if (rawLine.startsWith("@@")) {
      const hunkMatch = rawLine.match(/\+(\d+)/);
      newLineNumber = hunkMatch ? Number(hunkMatch[1]) : null;
      continue;
    }
    if (rawLine.startsWith("+++") || rawLine.startsWith("---")) continue;
    if (rawLine.startsWith("+")) {
      if (currentFile && newLineNumber != null) {
        entries.push({ file: currentFile, line: newLineNumber, text: rawLine.slice(1) });
        newLineNumber += 1;
      }
      continue;
    }
    if (rawLine.startsWith("-")) continue; // removed lines never land in the push
  }

  return entries;
}

export function scanAddedLines(entries, denylistStrings) {
  const hits = [];

  for (const { file, line, text } of entries) {
    if (text.includes(ALLOW_MARKER)) continue;

    for (const { name, re } of SECRET_PATTERNS) {
      const match = text.match(re);
      if (match) hits.push({ file, line, category: "secret", pattern: name, snippet: match[0] });
    }

    const ticketMatch = text.match(TICKET_REF_RE);
    if (ticketMatch) {
      hits.push({ file, line, category: "ticket-ref", pattern: "internal-ticket-id", snippet: ticketMatch[0] });
    }

    for (const { name, re } of INTERNAL_LINK_RES) {
      const match = text.match(re);
      if (match) hits.push({ file, line, category: "instance-identifying", pattern: name, snippet: match[0] });
    }

    for (const needle of denylistStrings) {
      if (needle.length >= 4 && text.includes(needle)) {
        hits.push({ file, line, category: "instance-identifying", pattern: "denylist-string", snippet: needle });
      }
    }
  }

  return hits;
}

/**
 * Never echo a matched secret/denylist value in full — this report's own
 * output can end up in a CI log or get pasted back into a comment, which
 * would defeat the point of catching it. Ticket-ref and instance-link
 * matches are structural (not secret values), so those print in full to stay
 * actionable; everything else is truncated to a short, non-reusable prefix.
 */
function redactSnippet(category, snippet) {
  if (category === "ticket-ref" || category === "instance-identifying") return snippet;
  if (snippet.length <= 6) return "*".repeat(snippet.length);
  return `${snippet.slice(0, 4)}…${snippet.slice(-2)} (redacted, ${snippet.length} chars)`;
}

export function formatReport(hits) {
  const lines = ["ERROR: private/internal info found in diff:\n"];
  for (const hit of hits) {
    const shown = redactSnippet(hit.category, hit.snippet);
    lines.push(`  ${hit.file}:${hit.line}: [${hit.category}:${hit.pattern}] ${JSON.stringify(shown)}`);
  }
  lines.push("\nRemove or redact the above before pushing to the fork or opening a PR.");
  return lines.join("\n");
}

export function runCheck({ base, exec = execSync, env = process.env, osModule = os, log = console.log, error = console.error }) {
  const diffText = exec === execSync ? runGitDiff(base, exec) : exec(base);
  const entries = parseAddedLines(diffText);
  const denylistStrings = resolveDenylistStrings(env, osModule);
  const hits = scanAddedLines(entries, denylistStrings);

  if (hits.length > 0) {
    error(formatReport(hits));
    return 1;
  }

  log(`  ✓  No private/internal info found in diff against ${base}.`);
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  const baseFlagIndex = args.indexOf("--base");
  const base = baseFlagIndex >= 0 ? args[baseFlagIndex + 1] : DEFAULT_BASE;
  process.exit(runCheck({ base }));
}

const isMainModule = process.argv[1] && process.argv[1].endsWith("check-private-info-before-push.mjs");
if (isMainModule) {
  main();
}
