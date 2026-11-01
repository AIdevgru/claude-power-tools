# Contributing

Thanks for helping. This page covers what a change needs before it can merge. The full reference
is in [docs/development.md](docs/development.md).

## Before you open a PR

1. Run `npm test`. It needs Node 20+ and Python 3.10+, and it must pass on your machine.
   CI runs it on Linux and Windows.
2. Edited a shared file? Shared files are listed in `scripts/sync-shared.mjs`, for example
   `reference/delivery-rules.md`. Edit the copy in the skill named there, then run
   `npm run sync-shared`.
3. Changed a skill's `description`? Run `npm run eval`. It costs model calls, so it isn't part of
   `npm test`.
4. Added or changed a scripted feature? Update its story in `tests/use-cases/<name>.md` and the
   test of the same name, `tests/use-cases/<name>.md.test.mjs`. Run the suite before changing
   tests and again after, and never weaken an assertion to make it pass.
5. Added a skill? It goes in `plugins/<plugin>/skills/<name>/` of the plugin it belongs to
   (see [Where things live](docs/development.md#where-things-live)). Calls to a skill in another
   plugin go through the Skill tool with that plugin's prefix, never a `../` path.
6. Add a line to the Unreleased section of [CHANGELOG.md](CHANGELOG.md).

## Bundled third-party skills

Impeccable and graphify are vendored unmodified, and `npm test` fails if a vendored file changes.
Send fixes upstream. To move to a new upstream tag, run
`node scripts/vendor.mjs sync <name> --ref <tag>` and commit the result. See
[THIRD_PARTY.md](THIRD_PARTY.md).

## Style

- Skills say "owner" for the person running the sessions and "peer" for other sessions.
- Put rules in plain sentences and short lists.
- Keep long reference material in a skill's `reference/` folder.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/), such as
  `fix(git-guard): ...`.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
