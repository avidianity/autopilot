# Isolate Workers and serialize verified integration

Each Work Item owns a reusable worktree while every Worker Attempt gets a fresh OpenCode session, allowing repair context to persist without growing conversations indefinitely.
Verified Worker commits enter a dedicated Run Branch through one serialized Integration Lane so concurrent implementation never mutates the user's checked-out branch or races integration state.
