# Pi lists its own models, per user

The Claude and Codex pickers read lists written into
`frontend-v2/src/lib/models.ts` and measured by hand against each CLI. The
comment there explains the choice: neither CLI prints what an account can run
before a session exists, and a stale written-down row fails in a way a person
can see, because the picker driver reports what the session does list.

Pi does print its list before a session exists. `pi --list-models` answers from
the user's own sign-in and pi's model catalogue without starting a session
(0.8 s on the devvm, offline, pi 0.87.1). Pi is also the harness where people
on the box are expected to sign into different providers, so one written-down
list would be wrong for somebody from the start. The pi picker therefore asks
pi, per OS user. `tmux-user-attach --pi-models` runs `pi --list-models` in the
user's own login shell, the way `--probe` answers `GET /new-commands`, and
tmux-api serves the result as `GET /pi-models`, cached per user.

## Consequences

- The list is pi's catalogue for the providers a user has signed into, and a
  catalogue is not an entitlement check. A model the account cannot use still
  appears, and choosing it shows the provider's error in the session.
- The Anthropic catalogue alone is 15 rows on pi 0.87.1, older models
  included. `--list-models` ignores pi's `enabledModels` setting (what
  `/scoped-models` writes), so tmux-api applies it: rows matching an exact id or
  a glob from that setting are kept, and the whole list is shown when the
  setting is empty or matches nothing. Pi's fuzzy patterns are not reproduced,
  so the filter is an approximation of pi's own.
- A user who has not signed in gets no rows and keeps the default choice, which
  starts pi on its own default model.
- A new model reaches the picker when pi's catalogue has it, with no lobby
  release.
- Thinking levels depend on the model. Claude Opus 5.5 offers `low` to `max`,
  Claude Haiku 4.5 `off` to `high`, and a model without reasoning only `off`.
  The composer offers pi's seven levels and pi clamps an unsupported one at
  start; inside a session, the picker offers the levels the lobby extension
  stamped for the current model.
