import {
  createServer,
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { readFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** A request received by the fixture server, recorded in arrival order. */
export interface FixtureRequest {
  method: string;
  /** Path and query, as sent by the client. */
  url: string;
  headers: IncomingHttpHeaders;
}

/** Handles one scripted path instead of the static site. */
export type FixtureRouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

export interface FixtureSiteServerOptions {
  /** Scripted responses keyed by pathname; checked before static files. */
  routes?: Record<string, FixtureRouteHandler>;
}

export interface FixtureSiteServer {
  baseUrl: string;
  port: number;
  /** Every request received so far (cleared with `requests.length = 0`). */
  requests: FixtureRequest[];
  close: () => Promise<void>;
}

export async function startFixtureSiteServer(
  siteRoot: string,
  options: FixtureSiteServerOptions = {},
): Promise<FixtureSiteServer> {
  const root = resolve(siteRoot);
  const requests: FixtureRequest[] = [];

  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: request.headers,
    });
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    const route = options.routes?.[pathname];
    if (route) {
      route(request, response);
      return;
    }
    void handleRequest(root, request.url || '/', response);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    close: () => closeServer(server),
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  // Browsers keep idle keep-alive sockets open; drop them so close() resolves.
  server.closeAllConnections();
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

async function handleRequest(
  root: string,
  requestUrl: string,
  response: ServerResponse,
): Promise<void> {
  try {
    const requestedPath = new URL(requestUrl, 'http://127.0.0.1').pathname;
    const pathWithDefault =
      requestedPath === '/' ? '/index.html' : requestedPath;

    const normalizedRelative = normalize(pathWithDefault).replace(
      /^(\.\.(\/|\\|$))+/,
      '',
    );

    const absolutePath = resolve(join(root, normalizedRelative));
    if (!absolutePath.startsWith(root)) {
      response.statusCode = 403;
      response.end('Forbidden');
      return;
    }

    const file = await readFile(absolutePath);
    response.statusCode = 200;
    response.setHeader(
      'content-type',
      CONTENT_TYPE_BY_EXT[extname(absolutePath)] || 'application/octet-stream',
    );
    response.end(file);
  } catch {
    response.statusCode = 404;
    response.end('Not found');
  }
}
