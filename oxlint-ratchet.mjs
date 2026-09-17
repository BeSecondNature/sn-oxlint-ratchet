#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const RATCHET_FILE = '.oxlint-ratchet.tsv';

const RATCHET_CONFIG = '.oxlintrc.ratchet.json';

const LINTABLE_FILE = /\.[cm]?[jt]sx?$/;

const VALUE_OPTIONS = new Set([
  '-c',
  '--config',
  '--tsconfig',
  '--ignore-path',
  '--ignore-pattern',
  '--threads',
  '-f',
  '--format',
  '--max-warnings',
]);

/** Runs Git and returns its trimmed output. */
const git = (root, args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/** Normalizes a path to POSIX separators. */
const toPosix = value => value.split(path.sep).join('/');

/** Normalizes an Oxlint diagnostic rule name. */
export const normalizeRule = code => {
  const match = /^(?<plugin>[^()]+)\((?<rule>[^()]+)\)$/.exec(code);

  if (!match?.groups) {
    return code.replace(/^@typescript-eslint\//, 'typescript/');
  }

  return match.groups.plugin === 'eslint'
    ? match.groups.rule
    : `${match.groups.plugin}/${match.groups.rule}`;
};

/** Builds the unique key for a file and rule pair. */
const ratchetKey = (filename, rule) => `${filename}\t${rule}`;

/** Parses a ratchet TSV into keyed entries. */
export const parseRatchet = source => {
  const entries = new Map();

  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();

    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const [filename, rawRule, rawCount, ...extra] = rawLine.split('\t');

    const rule = normalizeRule(rawRule ?? '');

    const count = Number(rawCount);

    if (
      !filename ||
      path.isAbsolute(filename) ||
      filename.split('/').includes('..') ||
      !rule ||
      extra.length > 0 ||
      !Number.isSafeInteger(count) ||
      count <= 0
    ) {
      throw new Error(`Invalid ratchet entry on line ${index + 1}.`);
    }

    const key = ratchetKey(filename, rule);

    if (entries.has(key)) {
      throw new Error(`Duplicate ratchet entry on line ${index + 1}.`);
    }

    entries.set(key, { count, filename, rule });
  }

  return entries;
};

/** Formats ratchet entries as deterministic TSV. */
export const formatRatchet = entries => {
  const lines = [...entries.values()]
    .filter(entry => entry.count > 0)
    .sort(
      (left, right) =>
        left.filename.localeCompare(right.filename) ||
        left.rule.localeCompare(right.rule),
    )
    .map(entry => `${entry.filename}\t${entry.rule}\t${entry.count}`);

  return ['# file\trule\tallowed errors', ...lines, ''].join('\n');
};

/** Reads the ratchet baseline, or returns an empty one. */
const readRatchet = ratchetPath =>
  existsSync(ratchetPath)
    ? parseRatchet(readFileSync(ratchetPath, 'utf8'))
    : new Map();

/** Lists package directories from the root workspace patterns. */
export const workspaceDirectories = root => {
  const { workspaces = [] } = JSON.parse(
    readFileSync(path.join(root, 'package.json'), 'utf8'),
  );

  return workspaces.flatMap(pattern => {
    if (!pattern.endsWith('/*')) {
      throw new Error(`Unsupported workspace pattern: ${pattern}`);
    }

    const parent = path.join(root, pattern.slice(0, -2));

    return readdirSync(parent, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(parent, entry.name))
      .filter(directory => existsSync(path.join(directory, 'package.json')));
  });
};

/** Reports whether an Oxlint rule setting is enabled. */
const ruleIsEnabled = setting =>
  (Array.isArray(setting) ? setting[0] : setting) !== 'off';

/** Reads root and workspace ratchet scopes. */
export const readScopes = root =>
  [...workspaceDirectories(root), root].flatMap(directory => {
    const configPath = path.join(directory, RATCHET_CONFIG);

    if (!existsSync(configPath)) {
      return [];
    }

    const config = JSON.parse(readFileSync(configPath, 'utf8'));

    const rules = new Set(
      Object.entries(config.rules ?? {})
        .filter(([, setting]) => ruleIsEnabled(setting))
        .map(([rule]) => normalizeRule(rule)),
    );

    if (rules.size === 0) {
      throw new Error(
        `${toPosix(path.relative(root, configPath))} has no rules.`,
      );
    }

    return [{ configPath, directory, rules }];
  });

/** Reports whether a repository file belongs to a scope. */
const scopeContains = (root, scope, filename) => {
  const relativeDirectory = toPosix(path.relative(root, scope.directory));

  return relativeDirectory === '' || filename.startsWith(`${relativeDirectory}/`);
};

/** Finds the scope enforcing a rule for a file. */
const findScope = (root, scopes, filename, rule) =>
  scopes.find(
    scope => scope.rules.has(rule) && scopeContains(root, scope, filename),
  );

/** Compares diagnostics with the baseline and returns ratchet outcomes. */
export const classifyDiagnostics = ({
  coveredFiles,
  coveredScopes,
  diagnostics,
  entries,
  frozen,
  root,
  scopes,
}) => {
  const grouped = new Map();

  const blockers = [];

  const messages = [];

  const notices = [];

  const nextEntries = new Map(entries);

  for (const diagnostic of diagnostics) {
    if (!findScope(root, scopes, diagnostic.filename, diagnostic.rule)) {
      continue;
    }

    const key = ratchetKey(diagnostic.filename, diagnostic.rule);

    const group = grouped.get(key) ?? [];

    group.push(diagnostic);

    grouped.set(key, group);
  }

  for (const [key, group] of grouped) {
    const allowed = entries.get(key)?.count ?? 0;

    if (group.length <= allowed) {
      continue;
    }

    blockers.push(...group);

    const { filename, rule } = group[0];

    messages.push(
      `${filename}: ${rule} increased from ${allowed} to ${group.length}.`,
    );
  }

  let removed = 0;

  for (const [key, entry] of entries) {
    const scope = findScope(root, scopes, entry.filename, entry.rule);

    if (!scope) {
      messages.push(
        `${entry.filename}: ${entry.rule} has no ratchet config.`,
      );

      continue;
    }

    if (!coveredFiles(entry.filename, scope)) {
      continue;
    }

    const current = grouped.get(key)?.length ?? 0;

    if (current >= entry.count) {
      continue;
    }

    if (frozen) {
      messages.push(
        `${entry.filename}: ${entry.rule} fell from ${entry.count} to ${current}; run lint locally to tighten the ratchet.`,
      );

      continue;
    }

    removed += entry.count - current;

    if (current === 0) {
      nextEntries.delete(key);
    } else {
      nextEntries.set(key, { ...entry, count: current });
    }
  }

  for (const scope of scopes) {
    if (!coveredScopes.has(scope.directory)) {
      continue;
    }

    for (const rule of scope.rules) {
      const remaining = [...nextEntries.values()].some(
        entry =>
          entry.rule === rule && scopeContains(root, scope, entry.filename),
      );

      if (remaining) {
        continue;
      }

      const message = `${toPosix(
        path.relative(root, scope.directory),
      )}: ${rule} has no debt; promote it to the normal Oxlint config.`;

      if (frozen) {
        messages.push(message);
      } else {
        notices.push(message);
      }
    }
  }

  return { blockers, messages, nextEntries, notices, removed };
};

/** Parses ratchet and passthrough Oxlint CLI options. */
const parseOptions = argv => {
  const options = {
    add: undefined,
    diff: undefined,
    frozen: process.env.CI === 'true' || process.env.CI === '1',
    oxlintArgs: [],
    ratchetOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--staged' || argument === '--changed') {
      options.diff = argument.slice(2);

      continue;
    }

    if (argument === '--ci') {
      options.frozen = true;

      options.ratchetOnly = true;

      continue;
    }

    if (argument === '--ratchet-only') {
      options.ratchetOnly = true;

      continue;
    }

    if (argument === '--frozen') {
      options.frozen = true;

      continue;
    }

    if (argument === '--add') {
      const packagePath = argv[index + 1];

      const rule = argv[index + 2];

      if (!packagePath || !rule) {
        throw new Error('--add requires a package path and rule.');
      }

      options.add = { packagePath, rule: normalizeRule(rule) };

      options.ratchetOnly = true;

      index += 2;

      continue;
    }

    options.oxlintArgs.push(argument);
  }

  return options;
};

/** Separates Oxlint flags from lint targets. */
const splitOxlintArgs = args => {
  const flags = [];

  const targets = [];

  let skipNext = false;

  for (const argument of args) {
    if (skipNext) {
      flags.push(argument);

      skipNext = false;

      continue;
    }

    if (VALUE_OPTIONS.has(argument)) {
      flags.push(argument);

      skipNext = true;

      continue;
    }

    if (argument.startsWith('-')) {
      flags.push(argument);
    } else {
      targets.push(argument);
    }
  }

  return { flags, targets };
};

/** Lists changed lintable files for the requested Git diff. */
const changedFiles = (root, kind) => {
  const trackedArgs =
    kind === 'staged'
      ? ['diff', '--cached', '--name-only', '--diff-filter=ACMRD', 'HEAD', '--']
      : ['diff', '--name-only', '--diff-filter=ACMRD', 'HEAD', '--'];

  const tracked = git(root, trackedArgs).split('\n').filter(Boolean);

  const untracked =
    kind === 'changed'
      ? git(root, ['ls-files', '--others', '--exclude-standard'])
          .split('\n')
          .filter(Boolean)
      : [];

  return [...new Set([...tracked, ...untracked])].filter(filename =>
    LINTABLE_FILE.test(filename),
  );
};

/** Reports whether requested targets cover a ratchet scope. */
const targetsCoverScope = (cwd, targets, scope) => {
  if (targets.length === 0) {
    return true;
  }

  return targets.some(target => {
    const absoluteTarget = path.resolve(cwd, target);

    return (
      absoluteTarget === scope.directory ||
      absoluteTarget.startsWith(`${scope.directory}${path.sep}`) ||
      scope.directory.startsWith(`${absoluteTarget}${path.sep}`)
    );
  });
};

/** Normalizes a diagnostic path and rule name. */
const normalizeDiagnostic = (diagnostic, cwd, root) => ({
  ...diagnostic,
  filename: toPosix(
    path.relative(root, path.resolve(cwd, diagnostic.filename)),
  ),
  rule: normalizeRule(diagnostic.code),
});

/** Runs the package's standard Oxlint configuration. */
const runStandardOxlint = ({ args, cwd, root }) => {
  const result = spawnSync(path.join(root, 'node_modules/.bin/oxlint'), args, {
    cwd,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
};

/** Runs only the rules configured for one ratchet scope. */
const runRatchetOxlint = ({ flags, root, scope, targets }) => {
  if (
    flags.some(
      argument =>
        argument === '-f' ||
        argument === '--format' ||
        argument.startsWith('--format='),
    )
  ) {
    throw new Error('oxlint-ratchet owns the Oxlint output format.');
  }

  const result = spawnSync(
    path.join(root, 'node_modules/.bin/oxlint'),
    [
      '--type-aware',
      '--config',
      scope.configPath,
      '-A',
      'all',
      ...[...scope.rules].flatMap(rule => ['-D', rule]),
      '--format=json',
      ...flags,
      ...targets,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        OXLINT_TSGOLINT_DANGEROUSLY_SUPPRESS_PROGRAM_DIAGNOSTICS: 'true',
      },
      maxBuffer: 256 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw result.error;
  }

  try {
    return JSON.parse(result.stdout)
      .diagnostics.filter(diagnostic => diagnostic.code)
      .map(diagnostic => normalizeDiagnostic(diagnostic, root, root));
  } catch {
    process.stderr.write(result.stderr || result.stdout);

    throw new Error(`Oxlint exited with status ${result.status}.`);
  }
};

/** Formats a diagnostic for terminal output. */
const formatDiagnostic = diagnostic => {
  const span = diagnostic.labels[0]?.span;

  const location = `${diagnostic.filename}:${span?.line ?? 1}:${
    span?.column ?? 1
  }`;

  return `${location}: ${diagnostic.rule}: ${diagnostic.message}`;
};

/** Atomically writes the ratchet baseline. */
const writeRatchet = (ratchetPath, entries) => {
  const temporaryPath = `${ratchetPath}.${process.pid}.tmp`;

  writeFileSync(temporaryPath, formatRatchet(entries));

  renameSync(temporaryPath, ratchetPath);
};

/** Builds a scope ratchet config with an added rule. */
const ratchetConfig = ({ directory, root, rule }) => {
  const configPath = path.join(directory, RATCHET_CONFIG);

  const existing = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf8'))
    : {
        $schema: toPosix(
          path.relative(
            directory,
            path.join(root, 'node_modules/oxlint/configuration_schema.json'),
          ),
        ),
        extends: ['./.oxlintrc.json'],
        rules: {},
      };

  if (existing.rules?.[rule]) {
    throw new Error(`${rule} is already adopted in this package.`);
  }

  const rules = Object.fromEntries(
    Object.entries({ ...existing.rules, [rule]: 'error' }).sort(
      ([left], [right]) => left.localeCompare(right),
    ),
  );

  return {
    configPath,
    source: `${JSON.stringify({ ...existing, rules }, null, 2)}\n`,
  };
};

/** Adopts a rule for a scope and records its existing debt. */
const addRule = ({ packagePath, rule }, root, ratchetPath) => {
  const directory = path.resolve(root, packagePath);

  if (!existsSync(directory)) {
    throw new Error(`${packagePath} does not exist.`);
  }

  const workspaces = new Set(
    workspaceDirectories(root).map(directory => realpathSync(directory)),
  );

  if (
    realpathSync(directory) !== realpathSync(root) &&
    !workspaces.has(realpathSync(directory))
  ) {
    throw new Error(`${packagePath} is not the root or a workspace package.`);
  }

  if (!existsSync(path.join(directory, '.oxlintrc.json'))) {
    throw new Error(`${packagePath} has no .oxlintrc.json.`);
  }

  const { configPath, source } = ratchetConfig({ directory, root, rule });

  const previous = existsSync(configPath)
    ? readFileSync(configPath, 'utf8')
    : undefined;

  writeFileSync(configPath, source);

  try {
    const scope = readScopes(root).find(item => item.configPath === configPath);

    const diagnostics = runRatchetOxlint({
      flags: [],
      root,
      scope,
      targets: [directory],
    }).filter(diagnostic => diagnostic.rule === rule);

    if (diagnostics.length === 0) {
      throw new Error(
        `${packagePath}: ${rule} has no debt; enable it normally instead.`,
      );
    }

    const entries = readRatchet(ratchetPath);

    const alreadyRecorded = [...entries.values()].some(
      entry =>
        entry.rule === rule && scopeContains(root, scope, entry.filename),
    );

    if (alreadyRecorded) {
      throw new Error(`${packagePath}: ${rule} already has baseline entries.`);
    }

    for (const diagnostic of diagnostics) {
      const key = ratchetKey(diagnostic.filename, diagnostic.rule);

      const entry = entries.get(key) ?? {
        count: 0,
        filename: diagnostic.filename,
        rule: diagnostic.rule,
      };

      entries.set(key, { ...entry, count: entry.count + 1 });
    }

    writeRatchet(ratchetPath, entries);

    console.log(
      `Adopted ${rule} in ${packagePath} with ${diagnostics.length} violation(s).`,
    );
  } catch (error) {
    if (previous === undefined) {
      unlinkSync(configPath);
    } else {
      writeFileSync(configPath, previous);
    }

    throw error;
  }
};

/** Runs the ratchet CLI. */
export const main = () => {
  const cwd = process.cwd();

  const root = git(cwd, ['rev-parse', '--show-toplevel']);

  const ratchetPath = path.join(root, RATCHET_FILE);

  const options = parseOptions(process.argv.slice(2));

  if (options.add) {
    addRule(options.add, root, ratchetPath);

    return;
  }

  const { flags, targets: requestedTargets } = splitOxlintArgs(
    options.oxlintArgs,
  );

  const files = options.diff ? changedFiles(root, options.diff) : undefined;

  if (options.diff && files.length === 0) {
    console.log('No changed JavaScript or TypeScript files to lint.');

    return;
  }

  const lintFiles = files?.filter(filename =>
    existsSync(path.join(root, filename)),
  );

  const standardTargets = lintFiles?.map(filename => path.join(root, filename));

  const standardStatus = options.ratchetOnly
    ? 0
    : standardTargets?.length === 0
      ? 0
      : runStandardOxlint({
          args: [...flags, ...(standardTargets ?? requestedTargets)],
          cwd,
          root,
        });

  const scopes = readScopes(root);

  const covered = scopes.filter(scope =>
    files
      ? files.some(filename => scopeContains(root, scope, filename))
      : targetsCoverScope(cwd, requestedTargets, scope),
  );

  const coveredScopes = new Set(covered.map(scope => scope.directory));

  const diagnostics = covered.flatMap(scope => {
    const scopeTargets = lintFiles
      ? lintFiles
          .filter(filename => scopeContains(root, scope, filename))
          .map(filename => path.join(root, filename))
      : [scope.directory];

    return scopeTargets.length === 0
      ? []
      : runRatchetOxlint({ flags, root, scope, targets: scopeTargets });
  });

  const entries = readRatchet(ratchetPath);

  const fileSet = files ? new Set(files) : undefined;

  const result = classifyDiagnostics({
    coveredFiles: (filename, scope) =>
      fileSet ? fileSet.has(filename) : coveredScopes.has(scope.directory),
    coveredScopes,
    diagnostics,
    entries,
    frozen: options.frozen,
    root,
    scopes,
  });

  for (const message of result.messages) {
    console.error(message);
  }

  for (const diagnostic of result.blockers) {
    console.error(formatDiagnostic(diagnostic));
  }

  for (const notice of result.notices) {
    console.log(notice);
  }

  if (options.diff === 'changed' && diagnostics.length > 0) {
    const blockers = new Set(result.blockers);

    const opportunities = diagnostics.filter(
      diagnostic => !blockers.has(diagnostic),
    );

    if (opportunities.length > 0) {
      console.log('Ratcheted lint opportunities in changed files:');

      for (const diagnostic of opportunities.slice(0, 20)) {
        console.log(formatDiagnostic(diagnostic));
      }

      if (opportunities.length > 20) {
        console.log(`...and ${opportunities.length - 20} more.`);
      }
    }
  }

  if (
    !options.frozen &&
    formatRatchet(result.nextEntries) !== formatRatchet(entries)
  ) {
    writeRatchet(ratchetPath, result.nextEntries);
  }

  if (result.removed > 0) {
    console.log(
      `Tightened the lint ratchet by ${result.removed} violation(s).`,
    );
  }

  if (
    standardStatus !== 0 ||
    result.blockers.length > 0 ||
    result.messages.length > 0
  ) {
    process.exitCode = 1;
  }
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
