import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node-fetch — factory must not reference outer variables (hoisted)
vi.mock('node-fetch', () => {
  const fn = vi.fn();
  return { default: fn };
});

import fetch from 'node-fetch';
import { MiroClient } from './MiroClient.js';

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

describe('MiroClient', () => {
  let client: MiroClient;

  beforeEach(() => {
    client = new MiroClient('test-token');
    mockFetch.mockReset();
  });

  describe('getTokenContext', () => {
    it('calls /v1/oauth-token with correct auth header', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        user: { id: 'user-1', name: 'Test User' },
        team: { id: 'team-1', name: 'Test Team' },
      }));

      const result = await client.getTokenContext();

      expect(mockFetch).toHaveBeenCalledWith('https://api.miro.com/v1/oauth-token', {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
        },
      });
      expect(result.user.id).toBe('user-1');
      expect(result.team.id).toBe('team-1');
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 401));

      await expect(client.getTokenContext()).rejects.toThrow('Miro API error: 401 Error');
    });
  });

  describe('getBoards', () => {
    it('calls /boards with limit=50 by default', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [{ id: 'b1', name: 'Board 1' }],
        total: 1, size: 1, offset: 0,
      }));

      const boards = await client.getBoards();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.miro.com/v2/boards?limit=50');
      expect(boards).toHaveLength(1);
      expect(boards[0].name).toBe('Board 1');
    });

    it('adds team_id query param when teamId is provided', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [], total: 0, size: 0, offset: 0,
      }));

      await client.getBoards({ teamId: 'team-123' });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('team_id=team-123');
      expect(url).toContain('limit=50');
    });

    it('adds owner query param when ownerId is provided', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [], total: 0, size: 0, offset: 0,
      }));

      await client.getBoards({ ownerId: 'user-456' });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('owner=user-456');
    });

    it('adds both team_id and owner when both provided', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [], total: 0, size: 0, offset: 0,
      }));

      await client.getBoards({ teamId: 'team-1', ownerId: 'user-1' });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('team_id=team-1');
      expect(url).toContain('owner=user-1');
    });

    it('paginates when total > returned size', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({
          data: [{ id: 'b1', name: 'Board 1' }, { id: 'b2', name: 'Board 2' }],
          total: 3, size: 2, offset: 0,
        }))
        .mockResolvedValueOnce(jsonResponse({
          data: [{ id: 'b3', name: 'Board 3' }],
          total: 3, size: 1, offset: 2,
        }));

      const boards = await client.getBoards();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(boards).toHaveLength(3);
      // Second call should include offset
      const secondUrl = mockFetch.mock.calls[1][0] as string;
      expect(secondUrl).toContain('offset=2');
    });

    it('does not paginate when all boards returned in first request', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [{ id: 'b1', name: 'Board 1' }],
        total: 1, size: 1, offset: 0,
      }));

      await client.getBoards();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('getBoardItems', () => {
    it('calls correct endpoint with limit=50', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [{ id: 'item-1', type: 'sticky_note' }],
      }));

      const items = await client.getBoardItems('board-1');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.miro.com/v2/boards/board-1/items?limit=50');
      expect(items).toHaveLength(1);
    });
  });

  describe('createStickyNote', () => {
    it('sends POST with correct data', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'sticky-1', type: 'sticky_note' }));

      const data = {
        data: { content: 'Hello' },
        style: { fillColor: 'yellow' },
        position: { x: 10, y: 20 },
      };

      const result = await client.createStickyNote('board-1', data);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.miro.com/v2/boards/board-1/sticky_notes',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(data),
        }),
      );
      expect(result.id).toBe('sticky-1');
    });

    it('sends geometry and shape when provided', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'sticky-2', type: 'sticky_note' }));

      const data = {
        data: { content: 'Sized', shape: 'rectangle' },
        style: { fillColor: 'blue' },
        position: { x: 0, y: 0 },
        geometry: { width: 2600 },
      };

      await client.createStickyNote('board-1', data);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data.shape).toBe('rectangle');
      expect(body.geometry.width).toBe(2600);
      expect(body.geometry.height).toBeUndefined();
    });
  });

  describe('createShape', () => {
    it('sends POST with correct data', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'shape-1', type: 'shape' }));

      const data = {
        data: { shape: 'rectangle', content: 'Box' },
        style: { fillColor: '#ff0000' },
        position: { x: 100, y: 200 },
        geometry: { width: 300, height: 150, rotation: 0 },
      };

      const result = await client.createShape('board-1', data);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.miro.com/v2/boards/board-1/shapes',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(data),
        }),
      );
      expect(result.id).toBe('shape-1');
    });
  });

  describe('getFrames', () => {
    it('calls correct endpoint with type=frame', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [{ id: 'frame-1', type: 'frame' }],
      }));

      const frames = await client.getFrames('board-1');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('type=frame');
      expect(frames).toHaveLength(1);
    });
  });

  describe('getItemsInFrame', () => {
    it('calls correct endpoint with parent_item_id', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [{ id: 'item-1', type: 'sticky_note' }],
      }));

      const items = await client.getItemsInFrame('board-1', 'frame-1');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('parent_item_id=frame-1');
      expect(items).toHaveLength(1);
    });
  });

  describe('bulkCreateItems', () => {
    it('sends POST to bulk endpoint', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [
          { id: 'item-1', type: 'sticky_note' },
          { id: 'item-2', type: 'shape' },
        ],
      }));

      const items = [
        { type: 'sticky_note', data: { content: 'Note 1' } },
        { type: 'shape', data: { shape: 'circle' } },
      ];

      const result = await client.bulkCreateItems('board-1', items);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.miro.com/v2/boards/board-1/items/bulk');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual(items);
      expect(result).toHaveLength(2);
    });

    it('throws on API error with details', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve('{"message":"Invalid item type","details":"missing required field"}'),
      });

      await expect(client.bulkCreateItems('board-1', []))
        .rejects.toThrow('Miro API error: 400 Bad Request');
    });
  });

  describe('getBoardDetails', () => {
    it('calls correct endpoint and returns board with policies', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        id: 'board-1',
        name: 'Test Board',
        sharingPolicy: {
          access: 'private',
          teamAccess: 'edit',
          organizationAccess: 'view',
          inviteToAccountAndBoardLinkAccess: 'viewer',
        },
        permissionsPolicy: {
          copyAccess: 'team_editors',
          sharingAccess: 'team_members_with_editing_rights',
        },
        viewLink: 'https://miro.com/app/board/board-1/',
      }));

      const result = await client.getBoardDetails('board-1');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.miro.com/v2/boards/board-1');
      expect(result.name).toBe('Test Board');
      expect(result.sharingPolicy?.access).toBe('private');
      expect(result.sharingPolicy?.teamAccess).toBe('edit');
      expect(result.permissionsPolicy?.copyAccess).toBe('team_editors');
      expect(result.viewLink).toBe('https://miro.com/app/board/board-1/');
    });

    it('normalizes policy wrapper from API response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        id: 'board-2',
        name: 'Wrapped Board',
        policy: {
          sharingPolicy: {
            access: 'edit',
            inviteToAccountAndBoardLinkAccess: 'editor',
          },
          permissionsPolicy: {
            copyAccess: 'anyone',
          },
        },
      }));

      const result = await client.getBoardDetails('board-2');

      expect(result.sharingPolicy?.access).toBe('edit');
      expect(result.sharingPolicy?.inviteToAccountAndBoardLinkAccess).toBe('editor');
      expect(result.permissionsPolicy?.copyAccess).toBe('anyone');
    });
  });

  describe('getBoardMembers', () => {
    it('returns all members in single page', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [
          { id: 'u1', name: 'Alice', role: 'owner', type: 'board_member' },
          { id: 'u2', name: 'Bob', role: 'editor', type: 'board_member' },
        ],
        total: 2, size: 2, offset: 0,
      }));

      const members = await client.getBoardMembers('board-1');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.miro.com/v2/boards/board-1/members?limit=50');
      expect(members).toHaveLength(2);
      expect(members[0].name).toBe('Alice');
      expect(members[0].role).toBe('owner');
    });

    it('paginates when total > returned size', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({
          data: [
            { id: 'u1', name: 'Alice', role: 'owner', type: 'board_member' },
            { id: 'u2', name: 'Bob', role: 'editor', type: 'board_member' },
          ],
          total: 3, size: 2, offset: 0,
        }))
        .mockResolvedValueOnce(jsonResponse({
          data: [
            { id: 'u3', name: 'Charlie', role: 'viewer', type: 'board_member' },
          ],
          total: 3, size: 1, offset: 2,
        }));

      const members = await client.getBoardMembers('board-1');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(members).toHaveLength(3);
      const secondUrl = mockFetch.mock.calls[1][0] as string;
      expect(secondUrl).toContain('offset=2');
    });
  });

  describe('updateBoardSharingPolicy', () => {
    it('sends PATCH with sharing policy', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        id: 'board-1',
        name: 'Test Board',
        sharingPolicy: {
          access: 'private',
          teamAccess: 'edit',
        },
      }));

      const result = await client.updateBoardSharingPolicy('board-1', {
        teamAccess: 'edit',
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.miro.com/v2/boards/board-1');
      const options = mockFetch.mock.calls[0][1];
      expect(options.method).toBe('PATCH');
      const body = JSON.parse(options.body);
      expect(body.policy.sharingPolicy.teamAccess).toBe('edit');
      expect(result.sharingPolicy?.teamAccess).toBe('edit');
    });

    it('normalizes policy wrapper from PATCH response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        id: 'board-2',
        name: 'Wrapped Board',
        policy: {
          sharingPolicy: {
            access: 'edit',
            inviteToAccountAndBoardLinkAccess: 'editor',
          },
          permissionsPolicy: {
            copyAccess: 'anyone',
          },
        },
      }));

      const result = await client.updateBoardSharingPolicy('board-2', {
        inviteToAccountAndBoardLinkAccess: 'editor',
      });

      expect(result.sharingPolicy?.access).toBe('edit');
      expect(result.sharingPolicy?.inviteToAccountAndBoardLinkAccess).toBe('editor');
      expect(result.permissionsPolicy?.copyAccess).toBe('anyone');
    });
  });

  describe('auth header', () => {
    it('uses Bearer token in all requests', async () => {
      const customClient = new MiroClient('my-secret-token');

      mockFetch.mockResolvedValueOnce(jsonResponse({
        data: [], total: 0, size: 0, offset: 0,
      }));

      await customClient.getBoards();

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBe('Bearer my-secret-token');
    });
  });
});
