import type {
  BoardFilterParams,
  BoardSortOption,
  MiroClient,
} from '../MiroClient.js';
import { resolveStickyNote, transformBulkItems } from '../transforms.js';
import { matchRoute } from './router.js';

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: unknown;
  queryStringParameters?: Record<string, string | undefined>;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function jsonResponse(statusCode: number, data: unknown): HttpResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(data) };
}

function errorResponse(statusCode: number, message: string): HttpResponse {
  return jsonResponse(statusCode, { error: message });
}

export async function handleRequest(
  req: HttpRequest,
  miroClient: MiroClient,
  boardFilter: BoardFilterParams,
): Promise<HttpResponse> {
  const route = matchRoute(req.method, req.path);
  if (!route) {
    return errorResponse(404, `No route found for ${req.method} ${req.path}`);
  }

  try {
    const { handler, params } = route;
    const body = req.body as Record<string, unknown> | undefined;

    switch (handler) {
      case 'listBoards': {
        const limit = Math.min(
          parseInt(req.queryStringParameters?.limit || '20', 10) || 20,
          50,
        );
        const offset =
          parseInt(req.queryStringParameters?.offset || '0', 10) || 0;
        const sort =
          (req.queryStringParameters?.sort as BoardSortOption) ||
          'last_modified';
        const query = req.queryStringParameters?.query;
        const scope = req.queryStringParameters?.scope || 'mine';
        const mergedFilter: BoardFilterParams = {
          ...boardFilter,
          sort,
          ...(query && { query }),
        };
        if (scope === 'mine' && !boardFilter.teamId) {
          try {
            const tokenContext = await miroClient.getTokenContext();
            mergedFilter.ownerId = tokenContext.user.id;
          } catch {
            // Fall back to all boards
          }
        }
        const boards = await miroClient.getBoardsPage(
          mergedFilter,
          limit,
          offset,
        );
        return jsonResponse(200, boards);
      }

      case 'getFrames': {
        const frames = await miroClient.getFrames(params.boardId);
        return jsonResponse(200, { frames });
      }

      case 'getItemsInFrame': {
        const items = await miroClient.getItemsInFrame(
          params.boardId,
          params.frameId,
        );
        return jsonResponse(200, { items });
      }

      case 'getBoardAccess': {
        const [boardDetails, members] = await Promise.all([
          miroClient.getBoardDetails(params.boardId),
          miroClient.getBoardMembers(params.boardId),
        ]);
        return jsonResponse(200, {
          board: { id: boardDetails.id, name: boardDetails.name },
          sharingPolicy: boardDetails.sharingPolicy,
          permissionsPolicy: boardDetails.permissionsPolicy,
          members,
        });
      }

      case 'getBoardShareLink': {
        const boardDetails = await miroClient.getBoardDetails(params.boardId);
        const link =
          boardDetails.viewLink ||
          `https://miro.com/app/board/${params.boardId}/`;
        return jsonResponse(200, {
          board: { id: boardDetails.id, name: boardDetails.name },
          viewLink: link,
          linkAccess:
            boardDetails.sharingPolicy?.inviteToAccountAndBoardLinkAccess ??
            'no_access',
        });
      }

      case 'createStickyNote': {
        if (!body) return errorResponse(400, 'Request body is required');
        const { stickyData, finalShape } = resolveStickyNote({
          boardId: params.boardId,
          content: body.content as string,
          color: (body.color as string) || 'yellow',
          x: (body.x as number) || 0,
          y: (body.y as number) || 0,
          size: body.size as string | undefined,
          width: body.width as number | undefined,
          shape: (body.shape as 'square' | 'rectangle') || 'square',
          parentId: body.parentId as string | undefined,
        });
        const stickyNote = await miroClient.createStickyNote(
          params.boardId,
          stickyData,
        );
        return jsonResponse(201, { id: stickyNote.id, shape: finalShape });
      }

      case 'bulkCreateItems': {
        if (!body) return errorResponse(400, 'Request body is required');
        const items = body.items as unknown[];
        if (!Array.isArray(items) || items.length === 0) {
          return errorResponse(
            400,
            'items array is required and must not be empty',
          );
        }
        if (items.length > 20) {
          return errorResponse(400, 'Maximum 20 items per request');
        }
        const transformedItems = transformBulkItems(items);
        const createdItems = await miroClient.bulkCreateItems(
          params.boardId,
          transformedItems,
        );
        return jsonResponse(201, {
          created: createdItems.length,
          items: createdItems,
        });
      }

      case 'createShape': {
        if (!body) return errorResponse(400, 'Request body is required');
        const pos =
          (body.position as { x?: number; y?: number; origin?: string }) || {};
        const geo =
          (body.geometry as {
            width?: number;
            height?: number;
            rotation?: number;
          }) || {};
        const shapeItem = await miroClient.createShape(params.boardId, {
          data: {
            shape: (body.shape as string) || 'rectangle',
            content: body.content as string | undefined,
          },
          style: (body.style as Record<string, unknown>) || {},
          position: { x: pos.x ?? 0, y: pos.y ?? 0, origin: pos.origin },
          geometry: {
            width: geo.width ?? 200,
            height: geo.height ?? 200,
            rotation: geo.rotation,
          },
        });
        return jsonResponse(201, {
          id: shapeItem.id,
          shape: body.shape || 'rectangle',
        });
      }

      case 'updateBoardSharing': {
        if (!body) return errorResponse(400, 'Request body is required');
        const sharingPolicy: Record<string, string> = {};
        for (const key of [
          'access',
          'teamAccess',
          'organizationAccess',
          'inviteToAccountAndBoardLinkAccess',
        ]) {
          if (body[key]) sharingPolicy[key] = body[key] as string;
        }
        if (Object.keys(sharingPolicy).length === 0) {
          return errorResponse(
            400,
            'At least one sharing policy field must be provided',
          );
        }
        await miroClient.updateBoardSharingPolicy(
          params.boardId,
          sharingPolicy,
        );
        const verified = await miroClient.getBoardDetails(params.boardId);
        return jsonResponse(200, {
          board: { id: verified.id, name: verified.name },
          sharingPolicy: verified.sharingPolicy,
        });
      }

      default:
        return errorResponse(500, `Unknown handler: ${handler}`);
    }
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Internal server error';
    const statusCode = message.includes('Miro API error: 404')
      ? 404
      : message.includes('Miro API error: 403')
        ? 403
        : message.includes('Miro API error: 401')
          ? 401
          : 500;
    return errorResponse(statusCode, message);
  }
}
