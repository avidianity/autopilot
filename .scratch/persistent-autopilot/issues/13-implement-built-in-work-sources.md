# Implement built-in Work Sources

Type: task
Status: resolved
Blocked by: 09

## Question

Implement and test first-party Work Sources for direct objectives, GitHub issues, failing tests/lint/typecheck/build checks, planning documents, Markdown task lists, explicit files, and repository TODOs without scanning sources irrelevant to objective.

## Answer

Adapters: `DirectObjectiveSource`, `GitHubIssueSource`, `RepositoryCheckSource`, `MarkdownTaskSource`, `ExplicitFileSource`, `TodoSource`. Discovery runs only sources selected by objective interpretation.

Tests: `test/planning.test.ts`, `test/supervisor.test.ts`.
