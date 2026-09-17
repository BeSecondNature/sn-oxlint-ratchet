import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRatchet } from './oxlint-ratchet.mjs';

import { buildMetricRows } from './lint-ratchet-metrics.mjs';

test('reports debt reduction without crediting new baseline debt', () => {
  const rows = buildMetricRows({
    contributor: 'alastairgarner',
    currentEntries: parseRatchet(
      'apps/a/new.ts\ttypescript/no-deprecated\t3\n',
    ),
    previousEntries: parseRatchet('apps/a/fixed.ts\teqeqeq\t2\n'),
    recordedAt: '2026-09-07T12:00:00Z',
    root: '/repo',
    scopes: [{
      configPath: '/repo/apps/a/.oxlintrc.ratchet.json',
      directory: '/repo/apps/a',
      rules: new Set(['typescript/no-deprecated']),
    }],
    sha: 'abc123',
    workspaces: ['/repo/apps/a'],
  });

  assert.deepEqual(rows.map(row => [row.rule, row.errors_removed, row.errors_added_to_baseline]), [
    ['eqeqeq', 2, 0],
    ['typescript/no-deprecated', 0, 3],
  ]);
});

test('reports root-scope debt in a single-package repository', () => {
  const rows = buildMetricRows({
    contributor: 'alastairgarner',
    currentEntries: parseRatchet(
      'src/example.ts\ttypescript/no-deprecated\t2\n',
    ),
    previousEntries: parseRatchet(
      'src/example.ts\ttypescript/no-deprecated\t3\n',
    ),
    recordedAt: '2026-09-17T12:00:00Z',
    root: '/repo',
    scopes: [{ directory: '/repo', rules: new Set(['typescript/no-deprecated']) }],
    sha: 'abc123',
    workspaces: [],
  });

  assert.equal(rows[0].scope, '.');
  assert.equal(rows[0].errors_removed, 1);
});
