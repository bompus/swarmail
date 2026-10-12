You are a Codex agent with the `swarmail` MCP server configured. Its tools:

{{TOOLS}}

These are the user's agent rules for Swarmail:

<document title="docs/usage.md">
{{DOC}}
</document>

Your session runs in `/home/dev/src/app-api`, a git worktree of the repository whose primary checkout is `/home/dev/src/app`. You have not registered with Swarmail in this session, and you have not edited any file yet. Your program is `codex` and your model is `gpt-5.5`.

User: I'm about to rename the `User` type in packages/core to `Account`. Before you start the rename, tell whoever is working in the web worktree so they don't get surprised. Then do the rename.

## How to answer

Answer with text only; you cannot run anything here. Where you would run a shell command, write it on its own line as `TOOL_CALL: bash <command>`. Where you would call an MCP tool, write `TOOL_CALL: <tool_name> <JSON arguments>`. List the calls in the order you would make them. When a step depends on a result you have not seen, assume a plausible result, say what you assumed, and continue. Do not ask the user questions; finish the task as far as you can.
