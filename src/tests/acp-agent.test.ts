import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "child_process";
import {
  Agent,
  Client,
  ClientSideConnection,
  NewSessionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@zed-industries/agent-client-protocol";
import { nodeToWebWritable, nodeToWebReadable } from "../utils.js";
import { markdownEscape, toolInfoFromToolUse, toolUpdateFromToolResult } from "../tools.js";
// Removed Claude Code SDK specific imports

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("ACP subprocess integration", () => {
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    const valid = spawnSync("tsc", { stdio: "inherit" });
    if (valid.status) {
      throw new Error("failed to compile");
    }
    // Start the subprocess
    child = spawn("npm", ["run", "--silent", "dev"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });
    child.on("error", (error) => {
      console.error("Error starting subprocess:", error);
    });
    child.on("exit", (exit) => {
      console.error("Exited with", exit);
    });
  });

  afterAll(() => {
    child.kill();
  });

  class TestClient implements Client {
    agent: Agent;
    files: Map<string, string> = new Map();
    receivedText: string = "";

    constructor(agent: Agent) {
      this.agent = agent;
    }

    takeReceivedText() {
      const text = this.receivedText;
      this.receivedText = "";
      return text;
    }

    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const optionId = params.options.find((p) => p.kind === "allow_once")!.optionId;

      return { outcome: { outcome: "selected", optionId } };
    }

    async sessionUpdate(params: SessionNotification): Promise<void> {
      console.error("RECEIVED", JSON.stringify(params, null, 4));

      if (
        params.update.sessionUpdate === "agent_message_chunk" &&
        params.update.content.type === "text"
      ) {
        this.receivedText += params.update.content.text;
      }
    }

    async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
      this.files.set(params.path, params.content);
      return null;
    }

    async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      const content = this.files.get(params.path) ?? "";
      return {
        content,
      };
    }
  }

  async function setupTestSession(cwd: string): Promise<{
    client: TestClient;
    connection: ClientSideConnection;
    newSessionResponse: NewSessionResponse;
  }> {
    let client;
    const connection = new ClientSideConnection(
      (agent) => {
        client = new TestClient(agent);
        return client;
      },
      nodeToWebWritable(child.stdin!),
      nodeToWebReadable(child.stdout!),
    );

    await connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    });

    const newSessionResponse = await connection.newSession({
      cwd,
      mcpServers: [],
    });

    return { client: client!, connection, newSessionResponse };
  }

  it("should connect to the ACP subprocess", async () => {
    const { client, connection, newSessionResponse } = await setupTestSession("./");

    await connection.prompt({
      prompt: [
        {
          type: "text",
          text: "Hello",
        },
      ],
      sessionId: newSessionResponse.sessionId,
    });

    expect(client.takeReceivedText()).not.toEqual("");
  }, 30000);

  // Test removed - cursor-agent doesn't have slash commands like Claude Code
  // cursor-agent uses different command structures
});

describe("tool conversions", () => {
  it("should handle Bash nicely", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01VtsS2mxUFwpBJZYd7BmbC9",
      name: "Bash",
      input: {
        command: "rm README.md.rm",
        description: "Delete README.md.rm file",
      },
    };

    expect(toolInfoFromToolUse(tool_use, {})).toStrictEqual({
      kind: "execute",
      title: "`rm README.md.rm`",
      content: [
        {
          content: {
            text: "Delete README.md.rm file",
            type: "text",
          },
          type: "content",
        },
      ],
    });
  });

  it("should handle Glob nicely", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01VtsS2mxUFwpBJZYd7BmbC9",
      name: "Glob",
      input: {
        pattern: "*/**.ts",
      },
    };

    expect(toolInfoFromToolUse(tool_use, {})).toStrictEqual({
      kind: "search",
      title: "Find `*/**.ts`",
      content: [],
      locations: [],
    });
  });

  it("should handle Task tool calls", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01ANYHYDsXcDPKgxhg7us9bj",
      name: "Task",
      input: {
        description: "Handle user's work request",
        prompt:
          'The user has asked me to "Create a Task to do the work!" but hasn\'t specified what specific work they want done. I need to:\n\n1. First understand what work needs to be done by examining the current state of the repository\n2. Look at the git status to see what files have been modified\n3. Check if there are any obvious tasks that need completion based on the current state\n4. If the work isn\'t clear from the context, ask the user to specify what work they want accomplished\n\nThe git status shows: "M src/tests/acp-agent.test.ts" - there\'s a modified test file that might need attention.\n\nPlease examine the repository state and determine what work needs to be done, then either complete it or ask the user for clarification on the specific task they want accomplished.',
        subagent_type: "general-purpose",
      },
    };

    expect(toolInfoFromToolUse(tool_use, {})).toStrictEqual({
      kind: "think",
      title: "Handle user's work request",
      content: [
        {
          content: {
            text: 'The user has asked me to "Create a Task to do the work!" but hasn\'t specified what specific work they want done. I need to:\n\n1. First understand what work needs to be done by examining the current state of the repository\n2. Look at the git status to see what files have been modified\n3. Check if there are any obvious tasks that need completion based on the current state\n4. If the work isn\'t clear from the context, ask the user to specify what work they want accomplished\n\nThe git status shows: "M src/tests/acp-agent.test.ts" - there\'s a modified test file that might need attention.\n\nPlease examine the repository state and determine what work needs to be done, then either complete it or ask the user for clarification on the specific task they want accomplished.',
            type: "text",
          },
          type: "content",
        },
      ],
    });
  });

  it("should handle LS tool calls", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01EEqsX7Eb9hpx87KAHVPTey",
      name: "LS",
      input: {
        path: "/Users/test/github/claude-code-acp",
      },
    };

    expect(toolInfoFromToolUse(tool_use, {})).toStrictEqual({
      kind: "search",
      title: "List the `/Users/test/github/claude-code-acp` directory's contents",
      content: [],
      locations: [],
    });
  });

  it("should handle Grep tool calls", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_016j8oGSD3eAZ9KT62Y7Jsjb",
      name: "Grep",
      input: {
        pattern: ".*",
      },
    };

    expect(toolInfoFromToolUse(tool_use, {})).toStrictEqual({
      kind: "search",
      title: 'grep ".*"',
      content: [],
    });
  });

  it("should handle Write tool calls", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01ABC123XYZ789",
      name: "Write",
      input: {
        file_path: "/Users/test/project/example.txt",
        content: "Hello, World!\nThis is test content.",
      },
    };

    expect(toolInfoFromToolUse(tool_use, {})).toStrictEqual({
      kind: "edit",
      title: "Write /Users/test/project/example.txt",
      content: [
        {
          type: "diff",
          path: "/Users/test/project/example.txt",
          oldText: null,
          newText: "Hello, World!\nThis is test content.",
        },
      ],
      locations: [{ path: "/Users/test/project/example.txt" }],
    });
  });

  it("should handle mcp__acp__write tool calls", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01GHI789JKL456",
      name: "mcp__acp__write",
      input: {
        abs_path: "/Users/test/project/config.json",
        content: '{"version": "1.0.0"}',
      },
    };

    expect(toolInfoFromToolUse(tool_use, {})).toStrictEqual({
      kind: "edit",
      title: "Write /Users/test/project/config.json",
      content: [
        {
          type: "diff",
          path: "/Users/test/project/config.json",
          oldText: null,
          newText: '{"version": "1.0.0"}',
        },
      ],
      locations: [{ path: "/Users/test/project/config.json" }],
    });
  });

  it("should handle Read tool calls", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01MNO456PQR789",
      name: "Read",
      input: {
        file_path: "/Users/test/project/readme.md",
      },
    };

    expect(toolInfoFromToolUse(tool_use, {})).toStrictEqual({
      kind: "read",
      title: "Read File",
      content: [],
      locations: [{ path: "/Users/test/project/readme.md", line: 0 }],
    });
  });

  it("should handle mcp__acp__read tool calls", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01YZA789BCD123",
      name: "mcp__acp__read",
      input: {
        abs_path: "/Users/test/project/data.json",
      },
    };

    expect(toolInfoFromToolUse(tool_use, {})).toStrictEqual({
      kind: "read",
      title: "Read /Users/test/project/data.json",
      content: [],
      locations: [{ path: "/Users/test/project/data.json", line: 0 }],
    });
  });

  it("should handle mcp__acp__read with limit", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01EFG456HIJ789",
      name: "mcp__acp__read",
      input: {
        abs_path: "/Users/test/project/large.txt",
        limit: 100,
      },
    };

    expect(toolInfoFromToolUse(tool_use, {})).toStrictEqual({
      kind: "read",
      title: "Read /Users/test/project/large.txt (1 - 100)",
      content: [],
      locations: [{ path: "/Users/test/project/large.txt", line: 0 }],
    });
  });

  it("should handle mcp__acp__read with offset and limit", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01KLM789NOP456",
      name: "mcp__acp__read",
      input: {
        abs_path: "/Users/test/project/large.txt",
        offset: 50,
        limit: 100,
      },
    };

    expect(toolInfoFromToolUse(tool_use, {})).toStrictEqual({
      kind: "read",
      title: "Read /Users/test/project/large.txt (51 - 150)",
      content: [],
      locations: [{ path: "/Users/test/project/large.txt", line: 50 }],
    });
  });

  it("should handle mcp__acp__read with only offset", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01QRS123TUV789",
      name: "mcp__acp__read",
      input: {
        abs_path: "/Users/test/project/large.txt",
        offset: 200,
      },
    };

    expect(toolInfoFromToolUse(tool_use, {})).toStrictEqual({
      kind: "read",
      title: "Read /Users/test/project/large.txt (from line 201)",
      content: [],
      locations: [{ path: "/Users/test/project/large.txt", line: 200 }],
    });
  });

  it("should handle WebFetch tool calls", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01LxEjDn8ci9SAc3qG7LbbXV",
      name: "WebFetch",
      input: {
        url: "https://agentclientprotocol.com",
        prompt:
          "Please provide a comprehensive summary of the content on this page, including what the Agent Client Protocol is, its main features, documentation links, and any other relevant information.",
      },
    };

    expect(toolInfoFromToolUse(tool_use, {})).toStrictEqual({
      kind: "fetch",
      title: "Fetch https://agentclientprotocol.com",
      content: [
        {
          content: {
            text: "Please provide a comprehensive summary of the content on this page, including what the Agent Client Protocol is, its main features, documentation links, and any other relevant information.",
            type: "text",
          },
          type: "content",
        },
      ],
    });
  });

  it("should handle WebSearch tool calls", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01NYMwiZFbdoQFxYxuQDFZXQ",
      name: "WebSearch",
      input: {
        query: "agentclientprotocol.com",
      },
    };

    expect(toolInfoFromToolUse(tool_use, {})).toStrictEqual({
      kind: "fetch",
      title: '"agentclientprotocol.com"',
      content: [],
    });
  });

  it("should handle KillBash entries", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01PhLms5fuvmdjy2bb6dfUKT",
      name: "KillBash",
      input: {
        shell_id: "bash_1",
      },
    };

    expect(toolInfoFromToolUse(tool_use, {})).toStrictEqual({
      kind: "execute",
      title: `Kill Process`,
      content: [],
    });
  });

  it("should handle BashOutput entries", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01SJUWPtj1QspgANgtpqGPuN",
      name: "BashOutput",
      input: {
        bash_id: "bash_1",
      },
    };

    expect(toolInfoFromToolUse(tool_use, {})).toStrictEqual({
      kind: "execute",
      title: `Tail Logs`,
      content: [],
    });
  });

  // Test removed - was specific to Claude Code SDK plan handling
  // cursor-agent uses different planning mechanisms

  it("should show full diff for multi edit tool", () => {
    const toolUse = {
      type: "tool_use",
      id: "toolu_01DEF456",
      name: "mcp__acp__multi-edit",
      input: {
        file_path: "/Users/test/project/config.json",
        edits: [
          {
            old_string: 'version": 1',
            new_string: 'version": 2',
            replace_all: false,
          },
          {
            old_string: 'enabled": false',
            new_string: 'enabled": true',
            replace_all: true,
          },
        ],
      },
    };
    const fileCache: { [key: string]: string } = {
      "/Users/test/project/config.json": JSON.stringify(
        {
          version: 1,
          filler: "filler",
          enabled: false,
        },
        null,
        4,
      ),
    };

    expect(toolInfoFromToolUse(toolUse, fileCache)).toEqual({
      content: [
        {
          newText: `{
    "version": 2,
    "filler": "filler",
    "enabled": true
}`,
          oldText: `{
    "version": 1,
    "filler": "filler",
    "enabled": false
}`,
          path: "/Users/test/project/config.json",
          type: "diff",
        },
      ],
      kind: "edit",
      locations: [
        {
          path: "/Users/test/project/config.json",
          line: 1,
        },
        {
          path: "/Users/test/project/config.json",
          line: 3,
        },
      ],
      title: "Edit /Users/test/project/config.json",
    });
  });

  it("should return empty update for successful edit result", () => {
    const toolUse = {
      type: "tool_use",
      id: "toolu_01MNO345",
      name: "mcp__acp__edit",
      input: {
        abs_path: "/Users/test/project/test.txt",
        old_string: "old",
        new_string: "new",
      },
    };

    const toolResult = {
      content: [
        {
          type: "text",
          text: "not valid json",
        },
      ],
      tool_use_id: "test",
      is_error: false,
      type: "tool_result" as const,
    };

    const update = toolUpdateFromToolResult(toolResult, toolUse);

    // Should return empty object when parsing fails
    expect(update).toEqual({});
  });

  it("should return content update for edit failure", () => {
    const toolUse = {
      type: "tool_use",
      id: "toolu_01MNO345",
      name: "mcp__acp__edit",
      input: {
        abs_path: "/Users/test/project/test.txt",
        old_string: "old",
        new_string: "new",
      },
    };

    const toolResult = {
      content: [
        {
          type: "text",
          text: "Failed to find `old_string`",
        },
      ],
      tool_use_id: "test",
      is_error: true,
      type: "tool_result" as const,
    };

    const update = toolUpdateFromToolResult(toolResult, toolUse);

    // Should return empty object when parsing fails
    expect(update).toEqual({
      content: [
        { content: { type: "text", text: "Failed to find `old_string`" }, type: "content" },
      ],
    });
  });
});

describe("escape markdown", () => {
  it("should escape markdown characters", () => {
    let text = "Hello *world*!";
    let escaped = markdownEscape(text);
    expect(escaped).toEqual("```\nHello *world*!\n```");

    text = "for example:\n```markdown\nHello *world*!\n```\n";
    escaped = markdownEscape(text);
    expect(escaped).toEqual("````\nfor example:\n```markdown\nHello *world*!\n```\n````");
  });
});
