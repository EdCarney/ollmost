# Ollmost

## E2E tests run on Ed's 16" M1 Max MacBook Pro only

Run the local E2E suite (`npm run build && npm run e2e`, see `e2e/run.mjs`) only on Ed's 16" M1 Max MacBook Pro. It has
the Ollama app, the signed-in cloud models and the macOS setup the suite expects.

Before running E2E, check which machine this session is on:

```sh
scutil --get LocalHostName   # must print Eds-M1-Max-MacBook-Pro-16
```

If it prints anything else, or the command doesn't exist (Linux, a cloud container), **don't run E2E here**. Run the
other checks (`npm run typecheck`, `npm run lint`, `npm test`) as usual, then hand off the E2E run:

1. Use `ListAgents` to find a Claude session running on that MacBook (a local session there, or a Remote Control
   session labeled with that machine), and `SendMessage` it the branch or PR to test and what to report back: the
   pass/fail count and any `FAIL` lines with their details.
2. If no session on that machine is reachable, stop and ask Ed to start one there. Don't report E2E as passed, and
   don't substitute a run from another machine.

On the MacBook itself, run E2E against the branch under test in a separate worktree (`git worktree add`), so the main
checkout stays untouched. The interactive shell aliases `npm` to a path that doesn't exist, so call
`/opt/homebrew/bin/npm` directly.
