import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'index.js');

export interface McpClientOptions {
  /** Working directory the server is launched from. */
  cwd?: string;
  /** Bound project root, exactly as .mcp.json sets it. */
  projectRoot?: string;
  /** Redirected global state dir, so tests never write to $HOME. */
  stateDir?: string;
  env?: Record<string, string>;
}

export interface ToolCallResult {
  text: string;
  isError: boolean;
}

/** Minimal JSON-RPC client speaking MCP over the server's stdio transport. */
export class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  public stderr = '';

  private constructor(options: McpClientOptions) {
    this.child = spawn('node', [SERVER_ENTRY], {
      cwd: options.cwd || options.projectRoot || PACKAGE_ROOT,
      env: {
        ...process.env,
        LOG_LEVEL: 'error',
        ...(options.projectRoot ? { PROJECT_ROOT: options.projectRoot } : {}),
        ...(options.stateDir ? { DEEPSEEK_MCP_STATE_DIR: options.stateDir } : {}),
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', (chunk) => this.consume(chunk.toString()));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString();
    });
  }

  public static async start(options: McpClientOptions = {}): Promise<McpClient> {
    const client = new McpClient(options);
    await client.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'deepseek-mcp-tests', version: '1.0.0' },
    });
    client.notify('notifications/initialized');
    return client;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        const resolver = message.id !== undefined ? this.pending.get(message.id) : undefined;
        if (resolver) {
          this.pending.delete(message.id);
          resolver(message);
        }
      } catch {
        /* not a JSON-RPC frame — ignore */
      }
    }
  }

  private notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  public rpc(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC '${method}' timed out after 180s. stderr:\n${this.stderr.slice(-2000)}`));
      }, 180_000);

      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  public async listTools(): Promise<Array<{ name: string; description: string; inputSchema: any }>> {
    const response = await this.rpc('tools/list', {});
    return response.result.tools;
  }

  public async call(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const response = await this.rpc('tools/call', { name, arguments: args });
    if (response.error) return { text: JSON.stringify(response.error), isError: true };
    return {
      text: response.result?.content?.[0]?.text ?? '',
      isError: Boolean(response.result?.isError),
    };
  }

  /** Convenience: call and return just the text, failing loudly on tool errors. */
  public async callOk(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await this.call(name, args);
    if (result.isError) throw new Error(`Tool '${name}' returned an error: ${result.text}`);
    return result.text;
  }

  public stop(): void {
    this.child.kill();
  }
}
