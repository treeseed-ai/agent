# Agent runtime workspace guidance

The Agent package is an Apache-2.0 repository. It has no contributor-grant checkbox, approved-committer allowlist, or contribution-attestation requirement. Human and agent changes use the same durable pull-request record and the same exact-head verification, review, staging, and release gates.

Agents must act only within assignment and capacity-provider authority, preserve exact repository and commit evidence, and keep GitHub tokens, provider private keys, membership credentials, and runtime secrets outside agent execution workspaces. Repository publication remains in the trusted provider/API boundary.
