import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

export interface CursorAgentMessage {
  type: "user" | "assistant" | "system";
  content: string;
  sessionId?: string;
}

export interface CursorAgentOptions {
  cwd?: string;
  model?: string;
  outputFormat?: "text" | "json";
  sessionId?: string;
}

export class CursorAgent extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private isRunning: boolean = false;
  private options: CursorAgentOptions;

  constructor(options: CursorAgentOptions = {}) {
    super();
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error("CursorAgent is already running");
    }

    const args: string[] = [];
    
    if (this.options.model) {
      args.push("--model", this.options.model);
    }
    
    if (this.options.outputFormat) {
      args.push("--output-format", this.options.outputFormat);
    }

    if (this.options.sessionId) {
      args.push("--resume", this.options.sessionId);
    }

    // Use non-interactive mode for ACP integration
    args.push("-p", "");

    this.process = spawn("cursor-agent", args, {
      cwd: this.options.cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    if (!this.process.stdout || !this.process.stdin || !this.process.stderr) {
      throw new Error("Failed to create cursor-agent process streams");
    }

    this.isRunning = true;

    this.process.stdout.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processOutput();
    });

    this.process.stderr.on("data", (data: Buffer) => {
      console.error("cursor-agent stderr:", data.toString());
    });

    this.process.on("exit", (code, signal) => {
      this.isRunning = false;
      this.emit("exit", { code, signal });
    });

    this.process.on("error", (error) => {
      this.isRunning = false;
      this.emit("error", error);
    });
  }

  private processOutput(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep the last incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        try {
          // Try to parse as JSON first
          const parsed = JSON.parse(line);
          this.emit("message", parsed);
        } catch {
          // If not JSON, treat as plain text
          this.emit("message", {
            type: "assistant",
            content: line,
          });
        }
      }
    }
  }

  async sendMessage(message: CursorAgentMessage): Promise<void> {
    if (!this.isRunning || !this.process || !this.process.stdin) {
      throw new Error("CursorAgent is not running");
    }

    // For cursor-agent CLI, we send the prompt directly
    const prompt = message.content + "\n";
    this.process.stdin.write(prompt);
  }

  async stop(): Promise<void> {
    if (!this.isRunning || !this.process) {
      return;
    }

    this.process.kill("SIGTERM");
    
    // Wait for process to exit gracefully
    await new Promise<void>((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }
      
      const timeout = setTimeout(() => {
        if (this.process) {
          this.process.kill("SIGKILL");
        }
        resolve();
      }, 5000);

      this.process.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.isRunning = false;
    this.process = null;
  }

  isAlive(): boolean {
    return this.isRunning && this.process !== null;
  }

  async createSession(): Promise<string> {
    // cursor-agent manages sessions internally
    // Return a generated session ID for tracking
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async listSessions(): Promise<string[]> {
    // This would require parsing cursor-agent ls output
    // For now, return empty array as cursor-agent manages sessions internally
    return [];
  }

  async resumeSession(sessionId: string): Promise<void> {
    this.options.sessionId = sessionId;
    if (this.isRunning) {
      await this.stop();
    }
    await this.start();
  }
}

export interface CursorAgentStreamingOptions extends CursorAgentOptions {
  onMessage?: (message: CursorAgentMessage) => void;
  onError?: (error: Error) => void;
  onExit?: (exitInfo: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

export async function createCursorAgentStream(
  options: CursorAgentStreamingOptions = {}
): Promise<CursorAgent> {
  const agent = new CursorAgent(options);

  if (options.onMessage) {
    agent.on("message", options.onMessage);
  }

  if (options.onError) {
    agent.on("error", options.onError);
  }

  if (options.onExit) {
    agent.on("exit", options.onExit);
  }

  await agent.start();
  return agent;
}

// Utility function to check if cursor-agent is installed
export async function checkCursorAgentInstallation(): Promise<boolean> {
  return new Promise((resolve) => {
    const process = spawn("cursor-agent", ["--help"], { stdio: "ignore" });
    
    process.on("exit", (code) => {
      resolve(code === 0);
    });
    
    process.on("error", () => {
      resolve(false);
    });
  });
}
