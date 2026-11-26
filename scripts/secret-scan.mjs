#!/usr/bin/env node
// Dependency-free secret scan for tracked-style files. CI also runs gitleaks; this works offline and in pre-commit.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'playwright-report',
  'test-results',
  'drizzle/meta',
]);
const SKIP_FILES = new Set(['package-lock.json']);
const RULES = [
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['Generic secret key (sk-)', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  [
    'Postgres URL with password',
    /postgres(?:ql)?:\/\/[^:\s/@]+:(?!password|pass|user|\[|\$|<|x{3,})[^@\s/]{6,}@(?!localhost|127\.0\.0\.1|host\b|h\/|example)/i,
  ],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
];

const hits = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(ROOT, p);
    if (SKIP_DIRS.has(name) || SKIP_DIRS.has(rel)) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (st.size < 2_000_000 && !SKIP_FILES.has(name)) {
      if (name.startsWith('.env') && name !== '.env.example')
        hits.push([rel, 'A real .env file is present in the tree (must not be committed)', 0]);
      let text;
      try {
        text = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue;
      text.split('\n').forEach((line, i) => {
        for (const [label, re] of RULES) if (re.test(line)) hits.push([rel, label, i + 1]);
      });
    }
  }
}
walk(ROOT);
if (hits.length) {
  console.error('Possible secrets found:');
  for (const [f, l, n] of hits) console.error(`  ${f}${n ? `:${n}` : ''}  ${l}`);
  process.exit(1);
}
console.log('Secret scan: no findings.');
