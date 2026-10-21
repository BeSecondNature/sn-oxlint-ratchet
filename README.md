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
violations with no allowance. Lower counts, files with no remaining violations
and deleted files pass, with notices to run `lint:ratchet` to tighten the
baseline. Stale rows without a ratchet config and rules with no remaining debt
also produce notices in CI. Once debt reaches zero, move the rule into the
regular Oxlint config and remove it from the ratchet config.

`--changed` checks unstaged and untracked JavaScript or TypeScript files.
`--staged` checks staged files. With neither option, the CLI checks every
adopting scope. Without `--ratchet-only`, it also runs standard Oxlint.

`--standard-only` runs standard Oxlint without checking or writing the ratchet.
It accepts the same targets and flags, including `--changed`, `--staged`
and `--type-aware`. It cannot be combined with `--ci`, `--ratchet-only` or `--add`.
When CI already checks every adopting scope with `lint:ratchet:ci`, use
`npm run lint:agent -- --standard-only` for a subsequent changed-file check
(where `lint:agent` runs `oxlint-ratchet --changed --type-aware --max-warnings=0`).
This keeps standard lint on changed files and avoids repeating their ratchet
checks. Keep the full `lint:ratchet:ci` step, the Git diff setup and any separate
checks such as type-only exports or API boundaries. Each adopting scope still
uses its own Oxlint invocation to preserve its config, overrides and ignores.

The package exports `normalizeRule`, `parseRatchet`, `formatRatchet`,
`workspaceDirectories`, `readScopes`, and `classifyDiagnostics` for consumers
that analyze baseline changes.

`oxlint-ratchet-metrics <base-ref> <sha> <recorded-at> <contributor>` writes
JSON Lines showing baseline changes by scope and rule. The caller can publish
that snapshot where it keeps engineering metrics.
