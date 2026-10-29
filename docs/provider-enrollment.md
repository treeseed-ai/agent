# Capacity provider enrollment submission

Agent owns a selectable `agent.provider.enrollment` native Cordis capability. Its public
`ProviderEnrollmentApplication.start(configuration, overrides?)` creates one native root with
selected proof and enrollment providers. `submit(input, signal)` invokes the existing control
plane registration endpoint over HTTPS using SDK `ProviderProtocolClient`; `close()` awaits
native disposal. The future manager composes these providers into its own root, rather than
nesting this standalone application.

Configuration contains the existing `ProviderConnectionApplication.Config` fields plus
`publicJwk` and an absolute owner-private `registrationKeyFile`. The latter contains exactly
`{registrationKey: string}` and is freshly read for each submission. No secret is accepted in
command output or returned registration. Public Ed25519 identity must hash to the configured
fingerprint, and proof audience must exactly equal the selected control-plane origin.

Input contains `idempotencyKey`, `displayName`, `capabilitySummary`, `supplyOffer` and optional
`metadata`, using existing SDK wire schemas. The coherent application validates configuration,
input and complete returned team/provider/fingerprint/key-generation identity even for selected
alternative enrollment providers. Foreign identity, missing/duplicate selections, cancellation,
private-file failures or unexpected provider errors expose fixed safe codes only.

The default plugin reads the registration code, signs the canonical unsigned submission
`{schemaVersion:1, displayName, publicJwk, capabilitySummary, supplyOffer, metadata?}` and sends
`{...unsigned, proof}` to `POST /v1/provider-registrations` with the existing
`Treeseed-Registration` authorization and stable idempotency key. Proof binds method, path,
audience, identity/version, fresh nonce/deadlines and unsigned body hash. The proof itself is
excluded from that body hash. This preserves the legacy Agent coordinator/identity boundary at
commit `7296807ee190eb024dd6de086aae65e43f1da1a3` in the same canonical repository.

A registration response retains its actual pending/approved/rejected/cancelled/expired state.
Submission alone does not approve membership, issue credentials/tokens, establish a live grant,
advertise productive capacity or enroll against production during verification. API/Identity
retain existing team authority and Keycloak-governed approval; Work/models remain Task 10.

Delivery: documentation → missing built public-interface acceptance → independent isolated TLS
receiver and identity/private-file/cancellation/replacement boundaries → plugin/application →
checks/build/all applicable tiers, exact archive consumer and full hosted verification. Permanent
tests use behavior names in their owning tiers. Test TLS uses a private temporary CA trusted
only by its child; no global trust change. All issues remain open under release policy.
