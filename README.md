# ACP adapter for cursor-agent

[![npm](https://img.shields.io/npm/v/cursor-agent-acp)](https://www.npmjs.com/package/cursor-agent-acp)

Use [cursor-agent](https://docs.cursor.com/en/cli/overview) from [ACP-compatible](https://agentclientprotocol.com) clients such as [Zed](https://zed.dev)!

This tool implements an ACP agent by using the [cursor-agent CLI](https://docs.cursor.com/en/cli/overview), supporting:

- Context @-mentions
- Images
- Tool calls (with permission requests)
- Following
- Edit review
- TODO lists
- Interactive (and background) terminals
- Custom [Slash commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands)
- Client MCP servers

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

## How to use

### Zed

The latest version of Zed can already use this adapter out of the box.

To use cursor-agent, open the Agent Panel and click "New cursor-agent Thread" from the `+` button menu in the top-right:

https://github.com/user-attachments/assets/ddce66c7-79ac-47a3-ad59-4a6a3ca74903

Read the docs on [External Agent](https://zed.dev/docs/ai/external-agents) support.

#### Installation

Make sure you have [cursor-agent CLI](https://docs.cursor.com/en/cli/overview) installed and configured first:

```bash
# Install cursor-agent CLI
$ curl https://cursor.com/install -fsS | bash
```

Follow [these directions](https://zed.dev/docs/ai/external-agents#add-custom-agents) for Zed:

```json
{
  "agent_servers": {
    "Cursor Agent": {
      "command": "npx",
      "args": ["-y", "cursor-agent-acp"],
      "env": {}
    }
  }
}
```

### Other clients

Setup instructions for other clients are coming soon. Feel free to [submit a PR](https://github.com/konsumer/cursor-agent-acp/pulls) to add yours!

The basic idea is `npx -y cursor-agent-acp` starts the ACP server.

## License

Apache-2.0
