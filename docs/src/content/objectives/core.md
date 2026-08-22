---
id: objective:agent-core
title: TreeSeed Agent Core Objective
description: TreeSeed Agent should run outbound-only capacity providers and trusted assignment executors beneath API-owned scheduling and authority.
date: 2026-06-22
summary: TreeSeed Agent owns provider-local execution, recovery, evidence, and capacity enforcement without becoming a control plane.
status: live
timeHorizon: long-term
motivation: Package-local workdays need a stable north star from the README so humans and agents can plan, execute, review, and report work without drifting across package ownership boundaries.
primaryContributor: agent-steward
relatedQuestions: []
relatedBooks: []
---

TreeSeed Agent exists to run outbound-only capacity providers and trusted assignment executors beneath API-owned scheduling, authorization, leases, and settlement.

This core objective is the starting direction for the TreeSeed Agent Knowledge Hub. It should influence every package-local workday, research note, implementation proposal, generated artifact, approval request, and release-readiness summary.

Agent owns provider-local runtime execution and must remain assignment-only. It must not become the API control plane, hidden scheduler, web app, admin UI, package workflow owner, or TreeDX product semantics layer. Without a configured trusted executor it advertises no executable capacity.

Agents working in this project should keep outputs grounded in the package README, package-local source evidence, and the TreeSeed package ownership map. When a task would cross into another package's authority, the agent should describe the boundary and route the work to the correct project instead of mutating outside this hub.
