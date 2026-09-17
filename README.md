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
writing. Once debt reaches zero, move the rule into the regular Oxlint config
and remove it from the ratchet config.

`--changed` checks unstaged and untracked JavaScript or TypeScript files.
`--staged` checks staged files. With neither option, the CLI checks every
adopting scope. Without `--ratchet-only`, it also runs standard Oxlint.

The package exports `normalizeRule`, `parseRatchet`, `formatRatchet`,
`workspaceDirectories`, `readScopes`, and `classifyDiagnostics` for consumers
that analyze baseline changes.

`oxlint-ratchet-metrics <base-ref> <sha> <recorded-at> <contributor>` writes
JSON Lines showing baseline changes by scope and rule. The caller can publish
that snapshot where it keeps engineering metrics.
