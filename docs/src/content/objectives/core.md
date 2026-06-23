---
id: objective:agent-core
title: TreeSeed Agent Core Objective
description: TreeSeed Agent should run Treeseed capacity providers, including provider API, provider manager, provider runner, worker runtime, AgentKernel execution, mode scheduling, provider-local capacity enforcement, Docker assets, and runtime tests.
date: 2026-06-22
summary: TreeSeed Agent exists to run Treeseed capacity providers, including provider API, provider manager, provider runner, worker runtime, AgentKernel execution, mode scheduling, provider-local capacity enforcement, Docker assets, and runtime tests while preserving its package boundary.
status: live
timeHorizon: long-term
motivation: Package-local workdays need a stable north star from the README so humans and agents can plan, execute, review, and report work without drifting across package ownership boundaries.
primaryContributor: agent-steward
relatedQuestions: []
relatedBooks: []
---

TreeSeed Agent exists to run Treeseed capacity providers, including provider API, provider manager, provider runner, worker runtime, AgentKernel execution, mode scheduling, provider-local capacity enforcement, Docker assets, and runtime tests.

This core objective is the starting direction for the TreeSeed Agent Knowledge Hub. It should influence every package-local workday, research note, implementation proposal, generated artifact, approval request, and release-readiness summary.

Agent owns provider-local runtime execution and must remain assignment-only. It must not become the API control plane, hidden scheduler, web app, admin UI, package workflow owner, or TreeDX product semantics layer.

Agents working in this project should keep outputs grounded in the package README, package-local source evidence, and the TreeSeed package ownership map. When a task would cross into another package's authority, the agent should describe the boundary and route the work to the correct project instead of mutating outside this hub.
