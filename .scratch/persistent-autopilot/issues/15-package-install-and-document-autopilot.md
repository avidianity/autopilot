# Package, install, and document Autopilot

Type: task
Status: resolved
Blocked by: 14

## Question

Produce concise architecture and operator documentation, package and installation instructions, install against local OpenCode, restart it as required, run final verification, and document behavior, dynamic instruction selection, Capability discovery, Work Sources, persistence/recovery, tests, and known limitations.

## Answer

Operator and architecture docs are in `README.md`. Project `opencode.json` points OpenCode at `./src/index.ts`. Restart OpenCode to load the plugin. Known limitations are listed in the README.
