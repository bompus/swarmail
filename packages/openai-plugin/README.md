# Swarmail for OpenAI's plugin directory

This is the package for OpenAI's plugin directory for ChatGPT and
Codex. It holds one skill, `swarmail`, that teaches the model to read this
session's Swarmail mail, list the sessions working in a repository and send
mail, using the `swarmail` command on the user's computer. It has no MCP
server: the directory accepts only public HTTPS servers, and Swarmail's server
runs on the user's computer.

To install Swarmail's MCP server in Codex, use the Codex plugin in
[`packages/codex-plugin`](../codex-plugin) instead.

To build the ZIP to upload, run this from the repository root:

```bash
(cd packages/openai-plugin && zip -r -X ../../swarmail-openai-plugin.zip .)
```

Raise `version` in `plugin.json` whenever the package changes, then upload the
new ZIP to the existing plugin at <https://platform.openai.com/plugins>.
