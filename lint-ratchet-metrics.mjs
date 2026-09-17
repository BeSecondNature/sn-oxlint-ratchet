#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  parseRatchet,
  readScopes,
  workspaceDirectories,
} from './oxlint-ratchet.mjs';

const key = (scope, rule) => `${scope}\t${rule}`;

const aggregate = ({ entries, root, scopes, workspaces }) => {
  const totals = new Map();
  const relativeScope = directory =>
    path.relative(root, directory).split(path.sep).join('/');

  for (const scope of scopes) {
    const name = relativeScope(scope.directory) || '.';

    for (const rule of scope.rules) {
      totals.set(key(name, rule), { errors: 0, rule, scope: name });
    }
  }

  for (const entry of entries.values()) {
    const configuredScope = scopes.find(candidate => {
      const name = relativeScope(candidate.directory);

      return (
        candidate.rules.has(entry.rule) &&
        (!name || entry.filename.startsWith(`${name}/`))
      );
    });

    const scope =
      configuredScope?.directory ??
      workspaces
        .filter(directory => {
          const name = relativeScope(directory);

          return entry.filename.startsWith(`${name}/`);
        })
        .sort((left, right) => right.length - left.length)[0] ??
      root;

    const name = relativeScope(scope) || '.';

    const item = totals.get(key(name, entry.rule)) ?? {
      errors: 0,
      rule: entry.rule,
      scope: name,
    };

    item.errors += entry.count;

    totals.set(key(name, entry.rule), item);
  }

  return totals;
};

export const buildMetricRows = ({
  contributor,
  currentEntries,
  previousEntries,
  recordedAt,
  root,
  scopes,
  sha,
  workspaces,
}) => {
  const current = aggregate({
    entries: currentEntries,
    root,
    scopes,
    workspaces,
  });

  const previous = aggregate({
    entries: previousEntries,
    root,
    scopes,
    workspaces,
  });

  return [...new Set([...current.keys(), ...previous.keys()])]
    .map(itemKey => current.get(itemKey) ?? previous.get(itemKey))
    .sort(
      (left, right) =>
        left.scope.localeCompare(right.scope) ||
        left.rule.localeCompare(right.rule),
    )
    .map(item => {
      const previousErrors =
        previous.get(key(item.scope, item.rule))?.errors ?? 0;

      const currentErrors =
        current.get(key(item.scope, item.rule))?.errors ?? 0;

      return {
        recorded_at: new Date(recordedAt).toISOString(),
        commit_sha: sha,
        contributor,
        scope: item.scope,
        rule: item.rule,
        allowed_errors: currentErrors,
        previous_allowed_errors: previousErrors,
        errors_removed: Math.max(previousErrors - currentErrors, 0),
        errors_added_to_baseline: Math.max(currentErrors - previousErrors, 0),
      };
    });
};

const main = () => {
  const [baseRef, sha, recordedAt, contributor] = process.argv.slice(2);

  if (!baseRef || !sha || !recordedAt || !contributor) {
    throw new Error(
      'Usage: lint-ratchet-metrics <base-ref> <sha> <recorded-at> <contributor>',
    );
  }

  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();

  const currentEntries = parseRatchet(
    readFileSync(path.join(root, '.oxlint-ratchet.tsv'), 'utf8'),
  );

  const previousEntries = parseRatchet(
    execFileSync('git', ['show', `${baseRef}:.oxlint-ratchet.tsv`], {
      cwd: root,
      encoding: 'utf8',
    }),
  );

  const rows = buildMetricRows({
    contributor,
    currentEntries,
    previousEntries,
    recordedAt,
    root,
    scopes: readScopes(root),
    sha,
    workspaces: workspaceDirectories(root),
  });

  process.stdout.write(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);

    process.exitCode = 1;
  }
}
