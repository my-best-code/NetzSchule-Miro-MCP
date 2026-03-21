import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-fetch', () => {
  const fn = vi.fn();
  return { default: fn };
});

import fetch from 'node-fetch';
import { MiroClient } from '../MiroClient.js';
import { handleRequest, type HttpRequest } from './handler.js';

const mockFetch = vi.mocked(fetch);

function jsonResponse(data: any, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

function makeReq(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'GET',
    path: '/boards',
    headers: {},
    ...overrides,
  };
}

describe('REST handler', () => {
  let client: MiroClient;

  beforeEach(() => {
    client = new MiroClient('test-token');
    mockFetch.mockReset();
  });

  describe('routing', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await handleRequest(makeReq({ path: '/unknown' }), client, {});
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toContain('No route found');
    });
  });

  describe('GET /boards', () => {
    it('returns boards list', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [{ id: 'b1', name: 'Board 1' }],
        total: 1, size: 1, offset: 0,
      }));

      const res = await handleRequest(makeReq(), client, {});
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.boards).toHaveLength(1);
      expect(data.boards[0].name).toBe('Board 1');
    });
  });

  describe('GET /boards/:boardId/frames', () => {
    it('returns frames for a board', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [{ id: 'f1', type: 'frame' }],
      }));

      const res = await handleRequest(
        makeReq({ path: '/boards/board-1/frames' }),
        client, {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.frames).toBeDefined();
    });
  });

  describe('GET /boards/:boardId/frames/:frameId/items', () => {
    it('returns items in frame', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [{ id: 'item-1', type: 'sticky_note' }],
      }));

      const res = await handleRequest(
        makeReq({ path: '/boards/board-1/frames/frame-1/items' }),
        client, {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.items).toBeDefined();
    });
  });

  describe('POST /boards/:boardId/sticky-notes', () => {
    it('creates a sticky note', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        id: 'sticky-1', type: 'sticky_note',
      }));

      const res = await handleRequest(
        makeReq({
          method: 'POST',
          path: '/boards/board-1/sticky-notes',
          body: { content: 'Hello', color: 'yellow' },
        }),
        client, {},
      );
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.id).toBe('sticky-1');
    });

    it('resolves size presets', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        id: 'sticky-2', type: 'sticky_note',
      }));

      const res = await handleRequest(
        makeReq({
          method: 'POST',
          path: '/boards/board-1/sticky-notes',
          body: { content: 'Big note', size: 'groß' },
        }),
        client, {},
      );
      expect(res.statusCode).toBe(201);

      // Verify the fetch was called with correct width
      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse((fetchCall[1] as any).body);
      expect(body.geometry.width).toBe(5600);
      expect(body.data.shape).toBe('rectangle');
    });

    it('returns 400 when body is missing', async () => {
      const res = await handleRequest(
        makeReq({ method: 'POST', path: '/boards/board-1/sticky-notes' }),
        client, {},
      );
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /boards/:boardId/items/bulk', () => {
    it('creates bulk items', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([
        { id: 'item-1', type: 'sticky_note' },
        { id: 'item-2', type: 'sticky_note' },
      ]));

      const res = await handleRequest(
        makeReq({
          method: 'POST',
          path: '/boards/board-1/items/bulk',
          body: {
            items: [
              { type: 'sticky_note', data: { content: 'A' }, color: 'red' },
              { type: 'sticky_note', data: { content: 'B' }, size: 'klein' },
            ],
          },
        }),
        client, {},
      );
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.created).toBe(2);
    });

    it('rejects more than 20 items', async () => {
      const items = Array.from({ length: 21 }, (_, i) => ({
        type: 'sticky_note', data: { content: `Item ${i}` },
      }));

      const res = await handleRequest(
        makeReq({
          method: 'POST',
          path: '/boards/board-1/items/bulk',
          body: { items },
        }),
        client, {},
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain('Maximum 20');
    });
  });

  describe('POST /boards/:boardId/shapes', () => {
    it('creates a shape', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        id: 'shape-1', type: 'shape',
      }));

      const res = await handleRequest(
        makeReq({
          method: 'POST',
          path: '/boards/board-1/shapes',
          body: { shape: 'circle', content: 'Hello' },
        }),
        client, {},
      );
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.id).toBe('shape-1');
      expect(data.shape).toBe('circle');
    });
  });

  describe('PATCH /boards/:boardId/sharing', () => {
    it('updates sharing policy', async () => {
      // First call: updateBoardSharingPolicy
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      // Second call: getBoardDetails (verification)
      mockFetch.mockResolvedValueOnce(jsonResponse({
        id: 'board-1',
        name: 'Test Board',
        sharingPolicy: { access: 'view', teamAccess: 'edit' },
      }));

      const res = await handleRequest(
        makeReq({
          method: 'PATCH',
          path: '/boards/board-1/sharing',
          body: { access: 'view', teamAccess: 'edit' },
        }),
        client, {},
      );
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.sharingPolicy.access).toBe('view');
    });

    it('rejects empty sharing policy', async () => {
      const res = await handleRequest(
        makeReq({
          method: 'PATCH',
          path: '/boards/board-1/sharing',
          body: {},
        }),
        client, {},
      );
      expect(res.statusCode).toBe(400);
    });
  });

  describe('error handling', () => {
    it('maps Miro 404 errors to 404 response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 404));

      const res = await handleRequest(makeReq(), client, {});
      expect(res.statusCode).toBe(404);
    });

    it('maps Miro 401 errors to 401 response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 401));

      const res = await handleRequest(makeReq(), client, {});
      expect(res.statusCode).toBe(401);
    });
  });
});
