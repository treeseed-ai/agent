# Guest environment preparation

Agent #525 owns the native `agent.environment` capability and its typed
`EnvironmentPreparer.prepare(definition, target, signal)` interface. It uses selected
`agent.environment.execution` and `agent.environment.authority` capabilities through native
Cordis injection and leases, never a second container or cached service registry.

An immutable environment is SDK `EnvironmentDefinition`: exact package/image, setup and
verification entries, explicit deadlines/output limits and offline-by-default network policy.
The trusted kernel supplies the exact sandbox ID and runner generation as `target`.
The authority provider authenticates that target and obtains fresh host and assignment policies; SDK intersection fails
before execution when a destination is not granted by both. Repeat live authority checks
before setup, before verification and before reporting success. A changed policy must not be
silently substituted after setup. The kernel separately retains exact authority and fences.

The execution provider receives the exact environment/entry, effective network and abort signal.
It must verify accepted artifact bytes and execute only inside the claimed Kata guest. The
preparer never spawns a process, invokes a shell, resolves an ambient script or opens a host
runtime socket. An implementation that cannot enforce the requested policy must fail visibly.
Cordis contexts are not a security sandbox; executable plugins are already accepted code.

Setup precedes verification. Bounded output is never returned or stored; only a safe success
receipt of the exact environment revision and canonical policy can cross the boundary. A
nonzero exit, excess output, invalid receipt, timeout/cancellation or grant change blocks the
handler. Cooperative providers must observe abort; a provider that ignores cancellation cannot
be disposed or reported complete until its outstanding operation actually ends. The selected
provider generation is retained through the operation and leases are awaited on all paths.

The default preparer is a native Cordis plugin. There is no permissive default execution or
fixture authority. Real root construction must select qualified execution and live-authority
providers, and missing/duplicate selections fail. Alternative fixture providers share the
same orchestration tests; those tests prove sequencing/binding only, not real Kata egress.
The worker owns verified guest destruction even after preparation failure. Productive Work
and model execution remain Task 10. Permanent tests use the four tier directories; all issues
remain open and owner PRs target cordis for maintainer review.
