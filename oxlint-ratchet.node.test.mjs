import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyDiagnostics,
  formatRatchet,
  normalizeRule,
  parseRatchet,
  readScopes,
} from './oxlint-ratchet.mjs';

const root = '/repo';

const scope = {
  configPath: '/repo/apps/a/.oxlintrc.ratchet.json',
  directory: '/repo/apps/a',
  rules: new Set(['typescript/no-deprecated']),
};

const diagnostic = (filename = 'apps/a/src/example.ts') => ({
  code: 'typescript(no-deprecated)',
  filename,
  labels: [{ span: { column: 1, line: 1 } }],
  message: 'This API is deprecated.',
  rule: 'typescript/no-deprecated',
  severity: 'error',
});

const classify = ({ diagnostics, entries, frozen = false, scopes = [scope] }) =>
  classifyDiagnostics({
    coveredFiles: () => true,
    coveredScopes: new Set(scopes.map(item => item.directory)),
    diagnostics,
    entries,
    frozen,
    root,
    scopes,
  });

test('normalizes Oxlint rule names', () => {
  assert.equal(normalizeRule('eslint(eqeqeq)'), 'eqeqeq');

  assert.equal(
    normalizeRule('typescript(no-explicit-any)'),
    'typescript/no-explicit-any',
  );
});

test('round-trips a sorted ratchet', () => {
  const entries = parseRatchet(
    'apps/a/b.ts\teqeqeq\t2\napps/a/a.ts\teqeqeq\t1\n',
  );

  assert.equal(
    formatRatchet(entries),
    '# file\trule\tallowed errors\napps/a/a.ts\teqeqeq\t1\napps/a/b.ts\teqeqeq\t2\n',
  );
});

test('discovers package-only ratchet configs', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'ratchet-'));

  mkdirSync(path.join(temporaryRoot, 'apps/a'), { recursive: true });

  mkdirSync(path.join(temporaryRoot, 'apps/b'), { recursive: true });

  writeFileSync(
    path.join(temporaryRoot, 'package.json'),
    JSON.stringify({ workspaces: ['apps/*'] }),
  );

  writeFileSync(path.join(temporaryRoot, 'apps/a/package.json'), '{}');

  writeFileSync(path.join(temporaryRoot, 'apps/b/package.json'), '{}');

  writeFileSync(
    path.join(temporaryRoot, 'apps/a/.oxlintrc.ratchet.json'),
    JSON.stringify({ rules: { 'typescript/no-deprecated': 'error' } }),
  );

  const scopes = readScopes(temporaryRoot);

  assert.equal(scopes.length, 1);

  assert.equal(scopes[0].directory, path.join(temporaryRoot, 'apps/a'));
});

test('discovers a root ratchet config without workspaces', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'ratchet-'));

  writeFileSync(path.join(temporaryRoot, 'package.json'), '{}');

  writeFileSync(
    path.join(temporaryRoot, '.oxlintrc.ratchet.json'),
    JSON.stringify({ rules: { 'typescript/no-deprecated': 'error' } }),
  );

  const scopes = readScopes(temporaryRoot);

  assert.equal(scopes.length, 1);

  assert.equal(scopes[0].directory, temporaryRoot);

  const result = classifyDiagnostics({
    coveredFiles: () => true,
    coveredScopes: new Set([temporaryRoot]),
    diagnostics: [diagnostic('src/example.ts')],
    entries: new Map(),
    frozen: false,
    root: temporaryRoot,
    scopes,
  });

  assert.equal(result.blockers.length, 1);
});

test('adopts and checks a rule at the repository root', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'ratchet-cli-'));

  const bin = path.join(temporaryRoot, 'node_modules/.bin/oxlint');

  mkdirSync(path.dirname(bin), { recursive: true });

  mkdirSync(path.join(temporaryRoot, 'src'));

  writeFileSync(path.join(temporaryRoot, 'package.json'), '{}');

  writeFileSync(path.join(temporaryRoot, '.oxlintrc.json'), '{}');

  writeFileSync(path.join(temporaryRoot, 'src/example.ts'), 'oldApi();\n');

  writeFileSync(bin, `#!/usr/bin/env node
console.log(JSON.stringify({ diagnostics: [{
  code: 'typescript(no-deprecated)',
  filename: 'src/example.ts',
  labels: [{ span: { line: 1, column: 1 } }],
  message: 'Deprecated API',
}] }));
`);

  chmodSync(bin, 0o755);

  execFileSync('git', ['init', '-q'], { cwd: temporaryRoot });

  const cli = fileURLToPath(new URL('./oxlint-ratchet.mjs', import.meta.url));

  execFileSync('node', [cli, '--add', '.', 'typescript/no-deprecated'], {
    cwd: temporaryRoot,
  });

  assert.match(
    readFileSync(path.join(temporaryRoot, '.oxlint-ratchet.tsv'), 'utf8'),
    /src\/example.ts\ttypescript\/no-deprecated\t1/,
  );

  execFileSync('node', [cli, '--ci'], { cwd: temporaryRoot });
});

test('allows same-count replacement but blocks an increase', () => {
  const entries = parseRatchet(
    'apps/a/src/example.ts\ttypescript/no-deprecated\t1\n',
  );

  const sameCount = classify({ diagnostics: [diagnostic()], entries });

  assert.equal(sameCount.blockers.length, 0);

  const increased = classify({
    diagnostics: [diagnostic(), diagnostic()],
    entries,
  });

  assert.equal(increased.blockers.length, 2);
});

test('gives new files zero allowance inside an adopted package', () => {
  const result = classify({
    diagnostics: [diagnostic('apps/a/src/new.ts')],
    entries: new Map(),
  });

  assert.equal(result.blockers.length, 1);
});

test('ignores packages that have not adopted the rule', () => {
  const result = classify({
    diagnostics: [diagnostic('apps/b/src/example.ts')],
    entries: new Map(),
  });

  assert.equal(result.blockers.length, 0);
});

test('does not carry an allowance between adopted packages', () => {
  const secondScope = {
    configPath: '/repo/apps/b/.oxlintrc.ratchet.json',
    directory: '/repo/apps/b',
    rules: new Set(['typescript/no-deprecated']),
  };

  const entries = parseRatchet(
    'apps/a/src/example.ts\ttypescript/no-deprecated\t1\n',
  );

  const result = classify({
    diagnostics: [diagnostic('apps/b/src/example.ts')],
    entries,
    scopes: [scope, secondScope],
  });

  assert.equal(result.blockers.length, 1);
});

test('tightens locally and rejects stale frozen baselines', () => {
  const entries = parseRatchet(
    'apps/a/src/example.ts\ttypescript/no-deprecated\t2\n',
  );

  const local = classify({ diagnostics: [diagnostic()], entries });

  assert.equal(
    local.nextEntries.get('apps/a/src/example.ts\ttypescript/no-deprecated')
      .count,
    1,
  );

  const frozen = classify({
    diagnostics: [diagnostic()],
    entries,
    frozen: true,
  });

  assert.match(frozen.messages[0], /fell from 2 to 1/);
});

test('requires package promotion when its debt reaches zero', () => {
  const entries = parseRatchet(
    'apps/a/src/example.ts\ttypescript/no-deprecated\t1\n',
  );

  const local = classify({ diagnostics: [], entries });

  assert.equal(local.notices.length, 1);

  const frozen = classify({
    diagnostics: [],
    entries: new Map(),
    frozen: true,
  });

  assert.match(frozen.messages.at(-1), /promote it/);
});
