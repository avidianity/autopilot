# Keep the Supervisor inside the OpenCode plugin

The Supervisor runs inside the legacy OpenCode plugin process rather than a separate local daemon so session events, permissions, and command control retain one lifecycle authority.
Durable state and startup reconciliation recover process-local work, while restart behavior defaults to a Recovery Hold and may be configured to resume automatically.
