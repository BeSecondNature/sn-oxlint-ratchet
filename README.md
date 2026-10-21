# @second-nature/oxlint-ratchet

Incrementally adopt Oxlint rules. Each `.oxlintrc.ratchet.json` enables rules
for one workspace, or for the repository root in a single-package repo.
`.oxlint-ratchet.tsv` records the allowed count per file and rule.

Install alongside Oxlint, then add scripts to the consuming repository:

```json
{
  "scripts": {
    "lint:ratchet": "oxlint-ratchet --ratchet-only --max-warnings=0",
    "lint:ratchet:ci": "oxlint-ratchet --ci --max-warnings=0",
    "lint:ratchet:add": "oxlint-ratchet --add"
  }
}
```

Adopt a rule with `npm run lint:ratchet:add -- . typescript/no-deprecated`
at the root, or replace `.` with a workspace path. A rule must have existing
debt; otherwise enable it in `.oxlintrc.json` directly. Commit the generated
config and baseline. Local lint tightens the baseline; `--ci` checks it without
writing. CI fails when a file/rule count exceeds its allowance, including
violations with no allowance, in every adopting scope.

Pass `--ci --changed-base <git-ref>` on pull requests to require authors to
tighten the baseline for files they change. The changed set uses
`git diff --name-only <git-ref>...HEAD`, including deleted JavaScript and
TypeScript files. Lower counts, cleared violations and rows for deleted files
fail for files in that set, with a message to run `lint:ratchet`. Outside the
set, the same situations produce notices and pass. The base only determines
which files require tightening; it does not restrict the full ratchet scan or
include uncommitted changes. Without `--changed-base`, such as on a push to
master after a merge, all decreases produce notices and only increases or
violations with no allowance fail. CI never rewrites the baseline.

Stale rows without a ratchet config and rules with no remaining debt also
produce notices in CI. Once debt reaches zero, move the rule into the regular
Oxlint config and remove it from the ratchet config.

`--changed` checks unstaged and untracked JavaScript or TypeScript files.
`--staged` checks staged files. With neither option, the CLI checks every
adopting scope. Without `--ratchet-only`, it also runs standard Oxlint.

`--standard-only` runs standard Oxlint without checking or writing the ratchet.
It accepts the same targets and flags, including `--changed`, `--staged`
and `--type-aware`. It cannot be combined with `--ci`, `--ratchet-only` or `--add`.
Where a pull request workflow tests a merge commit, run the full ratchet check
before any soft reset, comparing against the merge's first parent:

```sh
npm run lint:ratchet:ci -- --changed-base HEAD^1
```

With the scripts above, the exact CLI flags are
`--ci --max-warnings=0 --changed-base HEAD^1`. Fetch the merge's first parent
and the history needed to resolve the comparison. Keep the push-to-master
command as `npm run lint:ratchet:ci`, without a changed base.

After the workflow's existing soft reset to that first parent, use
`npm run lint:agent -- --standard-only` for its changed-file check
(where `lint:agent` runs `oxlint-ratchet --changed --type-aware --max-warnings=0`).
The exact CLI flags for this step are
`--changed --type-aware --max-warnings=0 --standard-only`.
This keeps standard lint on changed files and avoids repeating their ratchet
checks. Keep the full `lint:ratchet:ci` step, the Git diff setup, the trap that
restores HEAD and any separate checks such as type-only exports or API
boundaries. Each adopting scope still uses its own Oxlint invocation to
preserve its config, overrides and ignores.

The package exports `normalizeRule`, `parseRatchet`, `formatRatchet`,
`workspaceDirectories`, `readScopes`, and `classifyDiagnostics` for consumers
that analyze baseline changes.

`oxlint-ratchet-metrics <base-ref> <sha> <recorded-at> <contributor>` writes
JSON Lines showing baseline changes by scope and rule. The caller can publish
that snapshot where it keeps engineering metrics.
