import {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AvailableCommand,
  CancelNotification,
  ClientCapabilities,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestError,
  TerminalHandle,
  TerminalOutputResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@zed-industries/agent-client-protocol";
import { CursorAgent, CursorAgentMessage, CursorAgentOptions } from "./cursor-agent.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { v7 as uuidv7 } from "uuid";
import { nodeToWebReadable, nodeToWebWritable, Pushable, sleep, unreachable } from "./utils.js";
import { SessionNotification } from "@zed-industries/agent-client-protocol";
import { createMcpServer } from "./mcp-server.js";
import { AddressInfo } from "node:net";
import { toolInfoFromToolUse, planEntries, toolUpdateFromToolResult } from "./tools.js";

type Session = {
  cursorAgent: CursorAgent;
  cancelled: boolean;
  messages: CursorAgentMessage[];
};

type BackgroundTerminal =
  | {
      handle: TerminalHandle;
      status: "started";
      lastOutput: TerminalOutputResponse | null;
    }
  | {
      status: "aborted" | "exited" | "killed" | "timedOut";
      pendingOutput: TerminalOutputResponse;
    };

type ToolUseCache = {
  [key: string]: { type: "tool_use"; id: string; name: string; input: any };
};

// Implement the ACP Agent interface
export class CursorAcpAgent implements Agent {
  sessions: {
    [key: string]: Session;
  };
  client: AgentSideConnection;
  toolUseCache: ToolUseCache;
  fileContentCache: { [key: string]: string };
  backgroundTerminals: { [key: string]: BackgroundTerminal } = {};
  clientCapabilities?: ClientCapabilities;

  constructor(client: AgentSideConnection) {
    this.sessions = {};
    this.client = client;
    this.toolUseCache = {};
    this.fileContentCache = {};
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;
    return {
      protocolVersion: 1,
      // todo!()
      agentCapabilities: {
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
      },
      authMethods: [
        {
          description: "cursor-agent CLI authentication",
          name: "cursor-agent Auth",
          id: "cursor-agent-auth",
        },
      ],
    };
  }
  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = uuidv7();

    // Create cursor-agent instance
    const cursorAgent = new CursorAgent({
      cwd: params.cwd,
      outputFormat: "json",
    });

    // Set up message handling
    cursorAgent.on("message", (message: CursorAgentMessage) => {
      // Forward cursor-agent messages to ACP client
      this.handleCursorAgentMessage(sessionId, message);
    });

    cursorAgent.on("error", (error: Error) => {
      console.error("cursor-agent error:", error);
    });

    await cursorAgent.start();

    this.sessions[sessionId] = {
      cursorAgent,
      cancelled: false,
      messages: [],
    };

    // cursor-agent doesn't have slash commands like Claude Code
    // Return empty array for now
    const availableCommands: AvailableCommand[] = [];

    return {
      sessionId,
      availableCommands,
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    // cursor-agent handles authentication internally
    // No explicit authentication needed
  }

  private async handleCursorAgentMessage(sessionId: string, message: CursorAgentMessage): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session || session.cancelled) {
      return;
    }

    // Convert cursor-agent message to ACP notification
    const notification: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: message.content,
        },
      },
    };

    await this.client.sessionUpdate(notification);
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }

    session.cancelled = false;

    try {
      // Convert ACP prompt to cursor-agent message
      const message = promptToCursorAgent(params);
      
      // Send message to cursor-agent
      await session.cursorAgent.sendMessage(message);
      
      // Store the message
      session.messages.push(message);

      // Wait for cursor-agent response (it will be handled by the message event handler)
      // For now, we'll return end_turn immediately
      // In a real implementation, you'd want to wait for the actual response
      return { stopReason: "end_turn" };
      
    } catch (error) {
      console.error("Error in prompt:", error);
      return { stopReason: "refusal" };
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    session.cancelled = true;
    // cursor-agent doesn't have a direct interrupt method
    // We'll just mark as cancelled and stop processing
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const response = await this.client.readTextFile(params);
    if (!params.limit && !params.line) {
      this.fileContentCache[params.path] = response.content;
    }
    return response;
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const response = await this.client.writeTextFile(params);
    this.fileContentCache[params.path] = params.content;
    return response;
  }
}

// cursor-agent doesn't have slash commands like Claude Code
// This function is kept for compatibility but returns empty array

function formatUriAsLink(uri: string): string {
  try {
    if (uri.startsWith("file://")) {
      const path = uri.slice(7); // Remove "file://"
      const name = path.split("/").pop() || path;
      return `[@${name}](${uri})`;
    } else if (uri.startsWith("zed://")) {
      const parts = uri.split("/");
      const name = parts[parts.length - 1] || uri;
      return `[@${name}](${uri})`;
    }
    return uri;
  } catch {
    return uri;
  }
}

function promptToCursorAgent(prompt: PromptRequest): CursorAgentMessage {
  let content = "";

  for (const chunk of prompt.prompt) {
    switch (chunk.type) {
      case "text":
        content += chunk.text;
        break;
      case "resource_link": {
        const formattedUri = formatUriAsLink(chunk.uri);
        content += formattedUri;
        break;
      }
      case "resource": {
        if ("text" in chunk.resource) {
          const formattedUri = formatUriAsLink(chunk.resource.uri);
          content += formattedUri;
          content += `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>`;
        }
        break;
      }
      case "image":
        // cursor-agent CLI doesn't support images directly in the same way
        // We'll add a note about the image
        if (chunk.data) {
          content += `\n[Image: ${chunk.mimeType}]\n`;
        } else if (chunk.uri) {
          content += `\n[Image: ${chunk.uri}]\n`;
        }
        break;
      default:
        break;
    }
  }

  return {
    type: "user",
    content: content.trim(),
    sessionId: prompt.sessionId,
  };
}

// Message conversion functions for cursor-agent are handled in the handleCursorAgentMessage method

export function runAcp() {
  new AgentSideConnection(
    (client) => new CursorAcpAgent(client),
    nodeToWebWritable(process.stdout),
    nodeToWebReadable(process.stdin),
  );
}

// Type definitions for cursor-agent integration
// cursor-agent uses simpler message structures compared to Claude Code SDK
