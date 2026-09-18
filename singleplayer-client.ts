/**
 * HTTP client for the tiny Fabric companion mod used by --singleplayer.
 *
 * The mod binds to loopback only.  The custom header is intentional: browsers cannot
 * send it cross-origin without a successful CORS preflight, and the mod never grants
 * CORS.  This keeps a random web page from firing Minecraft commands while still
 * making setup zero-config for the person running the bridge and game on one PC.
 */

export const SINGLEPLAYER_ENDPOINT = 'http://127.0.0.1:25576';

type Fetch = typeof fetch;

export class SingleplayerClient {
  constructor(
    private readonly endpoint = SINGLEPLAYER_ENDPOINT,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit): Promise<string> {
    const response = await this.fetchImpl(`${this.endpoint}${path}`, {
      ...init,
      headers: { 'X-TikTok-Bridge': '1', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(body.trim() || `HTTP ${response.status}`);
    return body;
  }

  async connect(): Promise<void> {
    const reply = (await this.request('/health', { method: 'GET' })).trim();
    if (reply !== 'ready') throw new Error(reply || 'the single-player world is not ready');
  }

  send(command: string, commandId: string): Promise<string> {
    return this.request('/command', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-TikTok-Command-Id': commandId,
      },
      body: command,
    });
  }
}
