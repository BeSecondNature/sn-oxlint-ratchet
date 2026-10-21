import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyDiagnostics,
  formatRatchet,
  main,
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

const createRepository = (t, packages = ['a']) => {
  const directory = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'ratchet-runners-')),
  );

  t.after(() => rmSync(directory, { recursive: true, force: true }));

  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ workspaces: ['apps/*'] }),
  );

  for (const name of packages) {
    const workspace = path.join(directory, 'apps', name);

    mkdirSync(path.join(workspace, 'src'), { recursive: true });

    writeFileSync(path.join(workspace, 'package.json'), '{}');

    writeFileSync(path.join(workspace, 'src/example.ts'), 'oldApi();\n');

    writeFileSync(
      path.join(workspace, '.oxlintrc.ratchet.json'),
      JSON.stringify({ rules: { 'typescript/no-deprecated': 'error' } }),
    );
  }

  execFileSync('git', ['init', '-q'], { cwd: directory });

  return directory;
};

const commitRepository = (directory, message) => {
  execFileSync('git', ['add', '-A'], { cwd: directory });

  execFileSync(
    'git',
    [
      '-c',
      'user.name=Ratchet tests',
      '-c',
      'user.email=ratchet-tests@example.com',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-qm',
      message,
    ],
    { cwd: directory },
  );
};

// Inject runners to test orchestration without requiring an Oxlint installation.
const invokeMain = ({
  directory,
  args,
  listChangedFiles,
  runStandard,
  runRatchet,
}) => {
  const previousCwd = process.cwd();

  const previousArgv = process.argv;

  const previousExitCode = process.exitCode;

  const previousCI = process.env.CI;

  const stdout = [];

  const stderr = [];

  const log = mock.method(console, 'log', message => stdout.push(message));

  const error = mock.method(console, 'error', message => stderr.push(message));

  try {
    process.chdir(directory);

    process.argv = ['node', 'oxlint-ratchet.mjs', ...args];

    process.exitCode = undefined;

    process.env.CI = 'false';

    main({ listChangedFiles, runStandard, runRatchet });

    return { status: process.exitCode ?? 0, stderr, stdout };
  } finally {
    process.chdir(previousCwd);

    process.argv = previousArgv;

    process.exitCode = previousExitCode;

    if (previousCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = previousCI;
    }

    log.mock.restore();

    error.mock.restore();
  }
};

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
const typedFlags = process.argv.filter(argument => argument === '--type-aware');
if (typedFlags.length !== 1) {
  throw new Error('Expected exactly one --type-aware argument');
}
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

  execFileSync('node', [cli, '--type-aware', '--max-warnings=0'], {
    cwd: temporaryRoot,
  });
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

test('tightens locally and reports improvements in frozen baselines', () => {
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

  assert.equal(frozen.messages.length, 0);

  assert.equal(frozen.blockers.length, 0);

  assert.match(frozen.notices[0], /fell from 2 to 1; run lint:ratchet/);

  assert.deepEqual(frozen.nextEntries, entries);

  assert.equal(frozen.removed, 0);
});

test('reports package promotion when its debt reaches zero', () => {
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

  assert.equal(frozen.messages.length, 0);

  assert.match(frozen.notices.at(-1), /promote it/);
});

test('allows zero remaining violations in CI without removing the row', () => {
  const entries = parseRatchet(
    'apps/a/src/example.ts\ttypescript/no-deprecated\t1\n',
  );

  const result = classify({ diagnostics: [], entries, frozen: true });

  assert.equal(result.messages.length, 0);

  assert.equal(result.blockers.length, 0);

  assert.match(result.notices[0], /fell from 1 to 0; run lint:ratchet/);

  assert.deepEqual(result.nextEntries, entries);

  assert.equal(result.removed, 0);
});

test('keeps increases and unrecorded file/rule violations as CI failures', () => {
  const entries = parseRatchet(
    'apps/a/src/example.ts\ttypescript/no-deprecated\t1\n',
  );

  const result = classify({
    diagnostics: [
      diagnostic(),
      diagnostic(),
      diagnostic('apps/a/src/new.ts'),
      { ...diagnostic(), rule: 'typescript/no-unsafe-assignment' },
    ],
    entries,
    frozen: true,
    scopes: [
      {
        ...scope,
        rules: new Set([...scope.rules, 'typescript/no-unsafe-assignment']),
      },
    ],
  });

  assert.equal(result.blockers.length, 4);

  assert.equal(result.messages.length, 3);

  assert.match(result.messages[0], /increased from 1 to 2/);

  assert.match(result.messages[1], /new\.ts: .* increased from 0 to 1/);

  assert.match(result.messages[2], /no-unsafe-assignment increased from 0 to 1/);

  assert.deepEqual(result.nextEntries, entries);
});

test('reports orphaned rows as CI notices and preserves local errors', () => {
  const entries = parseRatchet(
    'apps/a/src/example.ts\ttypescript/no-deprecated\t1\n',
  );

  const frozen = classify({
    diagnostics: [],
    entries,
    frozen: true,
    scopes: [],
  });

  assert.equal(frozen.messages.length, 0);

  assert.match(frozen.notices[0], /has no ratchet config/);

  assert.deepEqual(frozen.nextEntries, entries);

  const local = classify({ diagnostics: [], entries, scopes: [] });

  assert.match(local.messages[0], /has no ratchet config/);

  assert.deepEqual(local.nextEntries, entries);
});

test('does not report improvements outside the covered files', () => {
  const entries = parseRatchet(
    'apps/a/src/example.ts\ttypescript/no-deprecated\t1\n',
  );

  const result = classifyDiagnostics({
    coveredFiles: () => false,
    coveredScopes: new Set([scope.directory]),
    diagnostics: [],
    entries,
    frozen: true,
    root,
    scopes: [scope],
  });

  assert.equal(result.messages.length, 0);

  assert.equal(result.notices.length, 0);

  assert.deepEqual(result.nextEntries, entries);
});

test('CI without a base notices falls, cleared violations and deleted files without rewriting', t => {
  const directory = createRepository(t);

  const ratchetPath = path.join(directory, '.oxlint-ratchet.tsv');

  const source =
    '# Keep this comment and row order.\n' +
    'apps/a/src/gone.ts\ttypescript/no-deprecated\t1\n' +
    'apps/a/src/cleared.ts\ttypescript/no-deprecated\t1\n' +
    'apps/a/src/example.ts\ttypescript/no-deprecated\t2\n';

  writeFileSync(ratchetPath, source);

  writeFileSync(path.join(directory, 'apps/a/src/cleared.ts'), 'newApi();\n');

  let ratchetCalls = 0;

  const result = invokeMain({
    directory,
    args: ['--ci', '--max-warnings=0'],
    runStandard: () => assert.fail('CI must not run standard lint'),
    runRatchet: () => {
      ratchetCalls += 1;

      return [diagnostic()];
    },
  });

  assert.equal(result.status, 0);

  assert.equal(ratchetCalls, 1);

  assert.deepEqual(result.stderr, []);

  assert.match(
    result.stdout.join('\n'),
    /gone\.ts: .* fell from 1 to 0; run lint:ratchet/,
  );

  assert.match(
    result.stdout.join('\n'),
    /example\.ts: .* fell from 2 to 1; run lint:ratchet/,
  );

  assert.match(
    result.stdout.join('\n'),
    /cleared\.ts: .* fell from 1 to 0; run lint:ratchet/,
  );

  assert.equal(readFileSync(ratchetPath, 'utf8'), source);
});

for (const changed of [true, false]) {
  for (const outcome of ['rise', 'unallowed', 'fall', 'cleared', 'deleted']) {
    test(`CI checks ${outcome} in ${changed ? 'changed' : 'unchanged'} files against a Git base`, t => {
      const directory = createRepository(t);

      const filename = 'apps/a/src/example.ts';

      const ratchetPath = path.join(directory, '.oxlint-ratchet.tsv');

      const source =
        outcome === 'unallowed'
          ? '# No allowance.\n'
          : `${filename}\ttypescript/no-deprecated\t2\n`;

      writeFileSync(ratchetPath, source);

      if (outcome === 'deleted' && !changed) {
        rmSync(path.join(directory, filename));
      }

      commitRepository(directory, 'Base');

      if (changed) {
        if (outcome === 'deleted') {
          rmSync(path.join(directory, filename));
        } else {
          writeFileSync(path.join(directory, filename), 'newApi();\n');
        }
      } else {
        writeFileSync(path.join(directory, 'README.md'), 'Unrelated change.\n');
      }

      commitRepository(directory, 'Pull request');

      const count = {
        rise: 3, unallowed: 1, fall: 1, cleared: 0, deleted: 0,
      }[outcome];

      const calls = [];

      const result = invokeMain({
        directory,
        args: ['--ci', '--changed-base', 'HEAD^1', '--max-warnings=0'],
        runStandard: () => assert.fail('CI must not run standard lint'),
        runRatchet: request => {
          calls.push(request);

          return Array.from({ length: count }, () => diagnostic());
        },
      });

      assert.equal(calls.length, 1);

      assert.deepEqual(calls[0].flags, ['--max-warnings=0']);

      assert.deepEqual(calls[0].targets, [path.join(directory, 'apps/a')]);

      const regression = outcome === 'rise' || outcome === 'unallowed';

      assert.equal(result.status, regression || changed ? 1 : 0);

      if (regression) {
        assert.match(result.stderr.join('\n'), /increased from \d to \d/);
      } else {
        assert.match(
          (changed ? result.stderr : result.stdout).join('\n'),
          /example\.ts: .* fell from 2 to [01]; run lint:ratchet/,
        );

        assert.deepEqual(changed ? result.stdout : result.stderr, []);
      }

      assert.equal(readFileSync(ratchetPath, 'utf8'), source);
    });
  }
}

test('CI uses the merge base for strict files and still scans every scope', t => {
  const directory = createRepository(t, ['a', 'b']);

  const ratchetPath = path.join(directory, '.oxlint-ratchet.tsv');

  const source =
    'apps/a/src/example.ts\ttypescript/no-deprecated\t2\n' +
    'apps/b/src/example.ts\ttypescript/no-deprecated\t2\n';

  writeFileSync(ratchetPath, source);

  commitRepository(directory, 'Common ancestor');

  const ancestor = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
  }).trim();

  execFileSync('git', ['checkout', '-qb', 'base'], { cwd: directory });

  writeFileSync(path.join(directory, 'apps/b/src/example.ts'), 'baseApi();\n');

  commitRepository(directory, 'Base branch change');

  execFileSync('git', ['checkout', '-qb', 'pull-request', ancestor], {
    cwd: directory,
  });

  writeFileSync(path.join(directory, 'apps/a/src/example.ts'), 'newApi();\n');

  commitRepository(directory, 'Pull request change');

  const calls = [];

  const result = invokeMain({
    directory,
    args: ['--ci', '--changed-base', 'base'],
    runStandard: () => assert.fail('CI must not run standard lint'),
    runRatchet: ({ scope }) => {
      const name = path.basename(scope.directory);

      calls.push(name);

      return [diagnostic(`apps/${name}/src/example.ts`)];
    },
  });

  assert.equal(result.status, 1);

  assert.deepEqual(calls, ['a', 'b']);

  assert.match(
    result.stderr.join('\n'),
    /apps\/a\/src\/example\.ts: .* fell from 2 to 1/,
  );

  assert.match(
    result.stdout.join('\n'),
    /apps\/b\/src\/example\.ts: .* fell from 2 to 1/,
  );

  assert.equal(result.stderr.length, 1);

  assert.equal(result.stdout.length, 1);

  assert.equal(readFileSync(ratchetPath, 'utf8'), source);
});

test('CI with an empty changed set still scans and notices improvements', t => {
  const directory = createRepository(t);

  const ratchetPath = path.join(directory, '.oxlint-ratchet.tsv');

  const source = 'apps/a/src/example.ts\ttypescript/no-deprecated\t2\n';

  writeFileSync(ratchetPath, source);

  commitRepository(directory, 'Base');

  const result = invokeMain({
    directory,
    args: ['--ci', '--changed-base', 'HEAD'],
    runStandard: () => assert.fail('CI must not run standard lint'),
    runRatchet: () => [diagnostic()],
  });

  assert.equal(result.status, 0);

  assert.deepEqual(result.stderr, []);

  assert.match(result.stdout.join('\n'), /fell from 2 to 1; run lint:ratchet/);

  assert.equal(readFileSync(ratchetPath, 'utf8'), source);
});

test('changed-base requires a Git ref', t => {
  const directory = createRepository(t);

  for (const args of [
    ['--ci', '--changed-base'],
    ['--ci', '--changed-base', '--max-warnings=0'],
  ]) {
    assert.throws(
      () => invokeMain({
        directory,
        args,
        runStandard: () => assert.fail('Invalid options must not run lint'),
        runRatchet: () => assert.fail('Invalid options must not run lint'),
      }),
      /--changed-base requires a Git ref/,
    );
  }
});

test('CI still returns a failing exit code for regressions', t => {
  const directory = createRepository(t);

  const ratchetPath = path.join(directory, '.oxlint-ratchet.tsv');

  const source = 'apps/a/src/example.ts\ttypescript/no-deprecated\t1\n';

  writeFileSync(ratchetPath, source);

  const result = invokeMain({
    directory,
    args: ['--ci'],
    runStandard: () => assert.fail('CI must not run standard lint'),
    runRatchet: () => [
      diagnostic(),
      diagnostic(),
      diagnostic('apps/a/src/new.ts'),
    ],
  });

  assert.equal(result.status, 1);

  assert.match(result.stderr.join('\n'), /increased from 1 to 2/);

  assert.match(result.stderr.join('\n'), /increased from 0 to 1/);

  assert.equal(readFileSync(ratchetPath, 'utf8'), source);
});

test('local ratchet-only mode still tightens and removes cleared rows', t => {
  const directory = createRepository(t);

  const ratchetPath = path.join(directory, '.oxlint-ratchet.tsv');

  writeFileSync(
    ratchetPath,
    'apps/a/src/example.ts\ttypescript/no-deprecated\t2\n' +
    'apps/a/src/gone.ts\ttypescript/no-deprecated\t1\n',
  );

  const result = invokeMain({
    directory,
    args: ['--ratchet-only'],
    runStandard: () =>
      assert.fail('Ratchet-only mode must not run standard lint'),
    runRatchet: () => [diagnostic()],
  });

  assert.equal(result.status, 0);

  assert.equal(
    readFileSync(ratchetPath, 'utf8'),
    '# file\trule\tallowed errors\napps/a/src/example.ts\ttypescript/no-deprecated\t1\n',
  );

  assert.match(
    result.stdout.join('\n'),
    /Tightened the lint ratchet by 2 violation\(s\)/,
  );
});

test('standard-only mode forwards flags and targets without reading the ratchet', t => {
  const directory = createRepository(t);

  const ratchetPath = path.join(directory, '.oxlint-ratchet.tsv');

  const source = 'This baseline must not be read or rewritten.\n';

  writeFileSync(ratchetPath, source);

  const calls = [];

  const result = invokeMain({
    directory: path.join(directory, 'apps/a'),
    args: ['--standard-only', '--type-aware', '--max-warnings=0', 'src'],
    runStandard: request => {
      calls.push(request);

      return 0;
    },
    runRatchet: () =>
      assert.fail('Standard-only mode must not run ratchet lint'),
  });

  assert.equal(result.status, 0);

  assert.deepEqual(calls, [
    {
      args: ['--type-aware', '--max-warnings=0', 'src'],
      cwd: path.join(directory, 'apps/a'),
      root: directory,
    },
  ]);

  assert.equal(readFileSync(ratchetPath, 'utf8'), source);
});

test('standard-only mode preserves standard lint failures', t => {
  const directory = createRepository(t);

  for (const status of [1, 2]) {
    const result = invokeMain({
      directory,
      args: ['--standard-only'],
      runStandard: () => status,
      runRatchet: () =>
        assert.fail('Standard-only mode must not run ratchet lint'),
    });

    assert.equal(result.status, 1);
  }
});

test('standard-only mode preserves changed and staged file selection', t => {
  const directory = createRepository(t);

  for (const mode of ['changed', 'staged']) {
    const calls = [];

    const result = invokeMain({
      directory,
      args: [
        '--standard-only',
        `--${mode}`,
        '--type-aware',
        '--max-warnings=0',
      ],
      listChangedFiles: (root, kind) => {
        assert.equal(root, directory);

        assert.equal(kind, mode);

        return ['apps/a/src/example.ts', 'apps/a/src/gone.ts'];
      },
      runStandard: request => {
        calls.push(request);

        return 0;
      },
      runRatchet: () =>
        assert.fail('Standard-only mode must not run ratchet lint'),
    });

    assert.equal(result.status, 0);

    assert.deepEqual(calls, [
      {
        args: [
          '--type-aware',
          '--max-warnings=0',
          path.join(directory, 'apps/a/src/example.ts'),
        ],
        cwd: directory,
        root: directory,
      },
    ]);
  }
});

test('standard-only mode skips Oxlint when no existing files changed', t => {
  const directory = createRepository(t);

  for (const files of [[], ['apps/a/src/gone.ts']]) {
    const result = invokeMain({
      directory,
      args: ['--standard-only', '--changed'],
      listChangedFiles: () => files,
      runStandard: () =>
        assert.fail('There are no existing changed files to lint'),
      runRatchet: () =>
        assert.fail('Standard-only mode must not run ratchet lint'),
    });

    assert.equal(result.status, 0);
  }
});

test('full CI with a changed base plus standard-only avoids repeated ratchet runs', t => {
  const directory = createRepository(t, ['a', 'b']);

  const ratchetPath = path.join(directory, '.oxlint-ratchet.tsv');

  const source =
    'apps/a/src/example.ts\ttypescript/no-deprecated\t2\n' +
    'apps/b/src/example.ts\ttypescript/no-deprecated\t1\n';

  writeFileSync(ratchetPath, source);

  for (const [aCount, bCount, standardStatus] of [
    [2, 1, 0],
    [1, 0, 0],
    [2, 0, 0],
    [2, 1, 1],
    [3, 1, 0],
    [2, 2, 0],
  ]) {
    const calls = [];

    const runners = {
      directory,
      listChangedFiles: () => ['apps/a/src/example.ts'],
      runStandard: () => {
        calls.push('standard');

        return standardStatus;
      },
      runRatchet: ({ scope }) => {
        const name = path.basename(scope.directory);

        calls.push(`ratchet ${name}`);

        return Array.from({ length: name === 'a' ? aCount : bCount }, () =>
          diagnostic(`apps/${name}/src/example.ts`),
        );
      },
    };

    const full = invokeMain({
      ...runners,
      args: ['--ci', '--changed-base', 'HEAD^1', '--max-warnings=0'],
    });

    assert.deepEqual(calls, ['ratchet a', 'ratchet b']);

    assert.equal(full.status, aCount !== 2 || bCount > 1 ? 1 : 0);

    calls.length = 0;

    const oldAgent = invokeMain({
      ...runners,
      args: ['--changed', '--frozen', '--type-aware', '--max-warnings=0'],
    });

    assert.deepEqual(calls, ['standard', 'ratchet a']);

    calls.length = 0;

    const newAgent = invokeMain({
      ...runners,
      args: [
        '--changed',
        '--standard-only',
        '--type-aware',
        '--max-warnings=0',
      ],
    });

    assert.deepEqual(calls, ['standard']);

    assert.equal(full.status || newAgent.status, full.status || oldAgent.status);

    assert.equal(readFileSync(ratchetPath, 'utf8'), source);
  }
});

test('standard-only mode rejects conflicting ratchet modes in either order', t => {
  const directory = createRepository(t);

  for (const mode of [['--ci'], ['--ratchet-only'], ['--add', '.', 'eqeqeq']]) {
    for (const args of [
      ['--standard-only', ...mode],
      [...mode, '--standard-only'],
    ]) {
      assert.throws(
        () => invokeMain({
          directory,
          args,
          runStandard: () => assert.fail('Conflicting modes must not run lint'),
          runRatchet: () => assert.fail('Conflicting modes must not run lint'),
        }),
        /--standard-only cannot be combined/,
      );
    }
  }
});
