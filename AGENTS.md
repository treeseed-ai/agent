# Agent runtime contribution policy

Agents may prepare the managed **Agent contribution attestation** only when their definition enables `delegated-project-authorization`, the assignment and capacity grant include `contribution_attestation`, and the trusted API issues a receipt bound to the exact repository, agent, capacity provider, assignment, base SHA, and head SHA.

Agents must never check or edit the **Human contribution affirmation** and may not create, broaden, renew, revoke, or supersede a project contribution authorization. The Agent runtime verifies the API signature and returns only the managed body block; GitHub token/App custody and PR mutation remain in the trusted provider/API boundary.

Missing, stale, mismatched, expired, revoked, or unsigned authority fails closed. Never pass GitHub credentials, provider private keys, membership credentials, or signing secrets into an agent execution workspace.
