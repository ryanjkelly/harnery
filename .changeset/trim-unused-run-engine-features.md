---
"harnery": minor
---

**Breaking:** removed the run engine's isolated workspace provider, integration and observer admission (ADR 0244). No recorded run outside Harnery's own tests and demos used them. Runs now always execute in the shared checkout.

- Commands removed: `harn run workspace`, `harn run workspaces`, `harn run integration prepare`, `harn run integration apply`, `harn run cleanup` and `harn run reclaim`.
- Flags removed from `harn run <script>`: `--isolation`, `--workspace-root` and `--observe-pressure`.
- `harnery/core/run` no longer exports the workspace provider, integration or admission APIs: `createLocalGitWorktreeProvider`, `probeLocalGitWorktreeProvider`, `prepareIntegration`, `applyIntegration`, `IntegrationPrepareParkedError`, `cleanupWorkspace`, `inspectWorkflowWorkspace`, `listWorkflowWorkspaceInspections`, `readWorkflowWorkspaceStatus`, `renderWorkflowWorkspaceStatus`, `deriveWorkspaceLifecycle`, `assertWorkspaceLifecycleTransition`, `isWorkspaceLifecycleState`, `validateProviderEventChain`, `WORKSPACE_BINDING_SCHEMA_VERSION`, `WORKSPACE_RECEIPT_SCHEMA_VERSION`, `observeWorkflowDiagnosticAdmission`, `failedWorkflowDiagnosticAdmissionObservation`, `WORKFLOW_DIAGNOSTIC_ADMISSION_SCHEMA_VERSION`, and their `Workspace*`, `Integration*`, `Provider*` and `WorkflowDiagnosticAdmission*` types.
- `EngineOpts` loses `isolation`, `workspace`, `gitWrite`, `diagnosticAdmission` and `observeDiagnosticAdmission`; `RunReport` loses `workspaceBinding` and `diagnosticAdmission`; `WorkflowProof` loses `execution` and `diagnostic_admission`; the sandbox projection evidence loses `git_grant`. A filesystem policy that names explicit `writableRoots` is now refused before any child launches.
- Policy documents accept only `shared` in `allowed_isolation`; a policy that lists `worktree`, `sandbox` or `remote` fails validation. `--policy`, `--approval-to`, parking, `harn run resume`, `ctx.authorize()`, `harn approval` and `harn policy` are unchanged.
- Diagnostic bundles no longer capture a shadow-admission source, and comparisons no longer report one.
- Old run records still load as history: `harn run proof` and the dashboard read records that carry workspace or admission fields. A parked run that executed in an isolated workspace can no longer be resumed.
- `.harnery/workspaces` joins the `harn storage retire` list.
