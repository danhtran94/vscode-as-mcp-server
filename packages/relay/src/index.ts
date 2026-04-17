#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, CallToolResult, JSONRPCRequest, JSONRPCResponse, ListToolsRequestSchema, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialTools } from './initial_tools.js';

const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.vscode-as-mcp-relay-cache');
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_INTERVAL_MS = 1000;

export interface MCPRelayOptions {
  serverUrl: string;
  cacheDir?: string;
  pollIntervalMs?: number;
  maxRetries?: number;
  retryIntervalMs?: number;
}

export class MCPRelay {
  readonly serverUrl: string;
  readonly cacheDir: string;
  readonly toolsCacheFile: string;
  readonly pollIntervalMs: number;
  readonly maxRetries: number;
  readonly retryIntervalMs: number;

  private mcpServer: McpServer;
  private pollTimer?: NodeJS.Timeout;

  constructor(options: MCPRelayOptions) {
    this.serverUrl = options.serverUrl;
    this.cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
    this.toolsCacheFile = path.join(this.cacheDir, 'tools-list-cache.json');
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;

    this.mcpServer = new McpServer({
      name: 'vscode-as-mcp',
      version: '0.0.1',
    }, {
      capabilities: {
        tools: {},
      },
    });

    this.mcpServer.server.setRequestHandler(ListToolsRequestSchema, (request) => this.handleListTools(request));
    this.mcpServer.server.setRequestHandler(CallToolRequestSchema, (request) => this.handleCallTool(request));
  }

  async handleListTools(request: { params?: unknown }): Promise<ListToolsResult> {
    const cachedTools = (await this.getToolsCache()) ?? initialTools;

    let tools: any[];
    try {
      const response = await this.requestWithRetry(this.serverUrl, JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: request.params,
        id: Math.floor(Math.random() * 1000000),
      } as JSONRPCRequest));
      const parsedResponse = response as JSONRPCResponse;
      if ('error' in parsedResponse) {
        throw new Error(`JSON-RPC error ${parsedResponse.error.code}: ${parsedResponse.error.message}`);
      }
      tools = (parsedResponse.result as { tools: any[] }).tools;
    } catch (err) {
      console.error(`Failed to fetch tools list: ${(err as Error).message}`);
      return { tools: cachedTools as any[] };
    }

    try {
      await this.saveToolsCache(tools);
    } catch (cacheErr) {
      console.error(`Failed to cache tools response: ${(cacheErr as Error).message}`);
    }

    return { tools };
  }

  async handleCallTool(request: { method: string; params?: unknown }): Promise<CallToolResult> {
    try {
      const response = await this.requestWithRetry(this.serverUrl, JSON.stringify({
        jsonrpc: '2.0',
        method: request.method,
        params: request.params,
        id: Math.floor(Math.random() * 1000000),
      } as JSONRPCRequest));
      const parsedResponse = response as JSONRPCResponse;
      if ('error' in parsedResponse) {
        throw new Error(`JSON-RPC error ${parsedResponse.error.code}: ${parsedResponse.error.message}`);
      }
      return parsedResponse.result as any;
    } catch (e) {
      console.error(`Failed to call tool: ${(e as Error).message}`);
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Failed to communicate with the VSCode as MCP Extension. Please ensure that the VSCode Extension is installed and that "MCP Server" is displayed in the status bar.`,
        }],
      };
    }
  }

  async pollOnce(): Promise<void> {
    let tools: any[];
    try {
      const resp = await this.requestWithRetry(this.serverUrl, JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
        id: Math.floor(Math.random() * 1000000),
      } as JSONRPCRequest));
      const parsed = resp as JSONRPCResponse;
      if ('error' in parsed) {
        return;
      }
      tools = (parsed.result as { tools: any[] }).tools;
    } catch {
      return;
    }

    const cachedTools = await this.getToolsCache();

    if (cachedTools && cachedTools.length === tools.length) {
      console.error('Fetched tools list is the same as the cached one, not updating cache');
      return;
    }

    try {
      await this.requestWithRetry(this.serverUrl + '/notify-tools-updated', '');
    } catch (err) {
      console.error(`Failed to notify tools updated: ${(err as Error).message}`);
    }

    try {
      await this.saveToolsCache(tools);
    } catch (cacheErr) {
      console.error(`Failed to cache tools response: ${(cacheErr as Error).message}`);
    }
  }

  async initCacheDir(): Promise<void> {
    try {
      try {
        await fs.mkdir(this.cacheDir, { recursive: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }
      }
    } catch (err) {
      console.error(`Failed to initialize cache directory: ${(err as Error).message}`);
    }
  }

  async saveToolsCache(tools: any[]): Promise<void> {
    await this.initCacheDir();
    try {
      await fs.writeFile(this.toolsCacheFile, JSON.stringify(tools), 'utf8');
      console.error('Tools list cache saved');
    } catch (err) {
      console.error(`Failed to save cache: ${(err as Error).message}`);
    }
  }

  async getToolsCache(): Promise<any[] | null> {
    try {
      await fs.access(this.toolsCacheFile);
      const cacheData = await fs.readFile(this.toolsCacheFile, 'utf8');
      return JSON.parse(cacheData) as any[];
    } catch (err) {
      console.error(`Failed to load cache file: ${(err as Error).message}`);
      return null;
    }
  }

  async requestWithRetry(url: string, body: string): Promise<unknown> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      if (attempt > 0) {
        console.error(`Retry attempt ${attempt + 1}/${this.maxRetries}`);
        await new Promise(resolve => setTimeout(resolve, this.retryIntervalMs));
      }

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: body,
        });

        const responseText = await response.text();

        // Only status codes >= 500 are errors
        if (response.status >= 500) {
          lastError = new Error(`Request failed with status ${response.status}: ${responseText}`);
          continue;
        }

        return JSON.parse(responseText);
      } catch (err) {
        lastError = err as Error;
      }
    }

    throw new Error(`All retry attempts failed: ${lastError?.message}`);
  }

  start(): Promise<void> {
    if (this.pollIntervalMs > 0 && !this.pollTimer) {
      this.pollTimer = setInterval(() => { void this.pollOnce(); }, this.pollIntervalMs);
    }
    return this.mcpServer.connect(new StdioServerTransport());
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}

// Parse command-line arguments
export function parseArgs(argv: string[] = process.argv.slice(2)): { serverUrl: string } {
  let serverUrl = 'http://localhost:60100';

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--server-url' && i + 1 < argv.length) {
      serverUrl = argv[i + 1];
      i++;
    }
  }

  return { serverUrl };
}

// Run only when invoked directly (not when imported as a library/test target).
const invokedAsScript = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (invokedAsScript) {
  try {
    const { serverUrl } = parseArgs();
    const relay = new MCPRelay({ serverUrl });
    await relay.start();
  } catch (err) {
    console.error(`Fatal error: ${(err as Error).message}`);
    process.exit(1);
  }
}
