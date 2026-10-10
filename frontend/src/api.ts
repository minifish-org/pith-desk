import { readPaths, mutationPaths, type ReadContracts, type MutationContracts, type DownloadContracts, type StreamContracts } from './contract.generated.ts';

export type ReadPath = keyof ReadContracts;
export type MutationPath = keyof MutationContracts;
export type MutationInput<P extends MutationPath> = MutationContracts[P]['input'];
export type MutationResponse<P extends MutationPath> = MutationContracts[P]['output'];
export type RequestOptions = { signal?: AbortSignal; keepalive?: boolean };
type ReadOptions<P extends ReadPath> = RequestOptions & ({} extends ReadContracts[P]['input'] ? { query?: ReadContracts[P]['input'] } : { query: ReadContracts[P]['input'] });

export interface ApiRequest {
  <P extends ReadPath>(path: P, ...options: {} extends ReadContracts[P]['input'] ? [options?: ReadOptions<P>] : [options: ReadOptions<P>]): Promise<ReadContracts[P]['output']>;
  <P extends MutationPath>(path: P, payload: MutationInput<P>, options?: RequestOptions): Promise<MutationResponse<P>>;
}

export type ApiMutate = <P extends MutationPath>(path: P, payload: MutationInput<P>, onResponse?: (response: MutationResponse<P>) => void) => Promise<boolean>;
export type ApiDownload = <P extends keyof DownloadContracts>(path: P, ...query: {} extends DownloadContracts[P] ? [query?: DownloadContracts[P]] : [query: DownloadContracts[P]]) => Promise<Blob>;

// The client keeps the process-local bearer token in headers and preserves the
// existing same-origin transport. The generated path decides the wire types.
export function createAPI(headers: (json?: boolean) => Headers): { request: ApiRequest; download: ApiDownload } {
  async function checked(response: Response): Promise<Response> {
    if (response.ok) return response;
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
    throw new Error(typeof message === 'string' ? message : `Request failed (${response.status}).`);
  }
  function queryURL(path: string, query?: object): string {
    const values = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null) values.set(key, String(value));
    const suffix = values.toString();
    return suffix ? `${path}?${suffix}` : path;
  }
  const request = async (path: string, input?: unknown, options?: RequestOptions): Promise<unknown> => {
    const readOptions = input as { query?: object; signal?: AbortSignal } | undefined;
    const read = (readPaths as readonly string[]).includes(path) && (input === undefined || !(mutationPaths as readonly string[]).includes(path) || (typeof input === 'object' && input !== null && 'query' in input));
    const body = read ? undefined : JSON.stringify(input);
    // Fetch keepalive has a browser-owned 64 KiB body allowance. Large drafts
    // use normal authenticated requests; the native quit guard awaits them.
    const keepalive = options?.keepalive && (!body || new TextEncoder().encode(body).length < 64 * 1024);
    const response = await checked(await fetch(read ? queryURL(path, readOptions?.query) : path, {
      method: read ? 'GET' : 'POST', headers: headers(!read), credentials: 'same-origin',
      body, signal: read ? readOptions?.signal : options?.signal, keepalive,
    }));
    return response.json();
  };
  const download = async (path: string, query?: object): Promise<Blob> => {
    const response = await checked(await fetch(queryURL(path, query), { headers: headers(), credentials: 'same-origin' }));
    return response.blob();
  };
  return { request: request as ApiRequest, download: download as ApiDownload };
}

// Stream payloads have the same Go-owned State schema as GET /api/state.
export function parseStream<P extends keyof StreamContracts>(_path: P, value: string): StreamContracts[P] {
  return JSON.parse(value) as StreamContracts[P];
}
