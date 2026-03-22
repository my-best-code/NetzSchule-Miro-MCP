

const PAGE_LIMIT = 50;

interface MiroBoardOwner {
  id: string;
  name: string;
  type: string;
}

interface MiroBoard {
  id: string;
  name: string;
  description?: string;
  owner?: MiroBoardOwner;
  team?: { id: string; name: string };
  createdAt?: string;
}

interface MiroBoardsResponse {
  data: MiroBoard[];
  total: number;
  size: number;
  offset: number;
}

interface MiroTokenContext {
  user: { id: string; name: string };
  team: { id: string; name: string };
}

export interface BoardFilterParams {
  teamId?: string;
  ownerId?: string;
}

export interface MiroSharingPolicy {
  access?: string;
  inviteToAccountAndBoardLinkAccess?: string;
  organizationAccess?: string;
  teamAccess?: string;
}

interface MiroPermissionsPolicy {
  copyAccess?: string;
  sharingAccess?: string;
}

interface MiroBoardDetailsRaw extends MiroBoard {
  sharingPolicy?: MiroSharingPolicy;
  permissionsPolicy?: MiroPermissionsPolicy;
  policy?: {
    sharingPolicy?: MiroSharingPolicy;
    permissionsPolicy?: MiroPermissionsPolicy;
  };
  viewLink?: string;
}

interface MiroBoardDetails extends MiroBoard {
  sharingPolicy?: MiroSharingPolicy;
  permissionsPolicy?: MiroPermissionsPolicy;
  viewLink?: string;
}

export interface MiroBoardMember {
  id: string;
  name: string;
  role: string;
  type: string;
}

interface MiroBoardMembersResponse {
  data: MiroBoardMember[];
  total: number;
  size: number;
  offset: number;
}

interface MiroItem {
  id: string;
  type: string;
  [key: string]: any;
}

interface MiroItemsResponse {
  data: MiroItem[];
  cursor?: string;
}

export interface StickyNoteData {
  data: { content: string; shape?: 'square' | 'rectangle' };
  style: { fillColor: string };
  position: { x: number; y: number };
  geometry?: { width: number };
  parent?: { id: string };
}

export interface ShapeData {
  data: { shape: string; content?: string };
  style: Record<string, unknown>;
  position: { x: number; y: number; origin?: string };
  geometry: { width: number; height: number; rotation?: number };
}

interface FetchOptions {
  method?: string;
  body?: unknown;
  apiVersion?: string;
}

export class MiroClient {
  constructor(private token: string) {}

  private async fetchApi(path: string, options: FetchOptions = {}) {
    const version = options.apiVersion ?? 'v2';
    const url = `https://api.miro.com/${version}${path}`;
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Miro API error: ${response.status} ${response.statusText} — ${errorText}`);
    }

    return response.json();
  }

  private normalizeBoardDetails(raw: MiroBoardDetailsRaw): MiroBoardDetails {
    return {
      ...raw,
      sharingPolicy: raw.sharingPolicy ?? raw.policy?.sharingPolicy,
      permissionsPolicy: raw.permissionsPolicy ?? raw.policy?.permissionsPolicy,
    };
  }

  async getTokenContext(): Promise<MiroTokenContext> {
    return this.fetchApi('/oauth-token', { apiVersion: 'v1' }) as Promise<MiroTokenContext>;
  }

  async getBoardsPage(params: BoardFilterParams | undefined, limit: number, offset: number): Promise<MiroBoardsResponse> {
    const queryParts: string[] = [`limit=${limit}`];
    if (offset > 0) queryParts.push(`offset=${offset}`);
    if (params?.teamId) queryParts.push(`team_id=${params.teamId}`);
    if (params?.ownerId) queryParts.push(`owner=${params.ownerId}`);
    return this.fetchApi(`/boards?${queryParts.join('&')}`) as Promise<MiroBoardsResponse>;
  }

  async getBoards(params?: BoardFilterParams): Promise<MiroBoard[]> {
    const queryParts: string[] = [`limit=${PAGE_LIMIT}`];
    if (params?.teamId) queryParts.push(`team_id=${params.teamId}`);
    if (params?.ownerId) queryParts.push(`owner=${params.ownerId}`);
    const query = queryParts.length ? `?${queryParts.join('&')}` : '';

    const allBoards: MiroBoard[] = [];
    let offset = 0;

    while (true) {
      const separator = query ? '&' : '?';
      const paginatedQuery = `${query}${offset > 0 ? `${separator}offset=${offset}` : ''}`;
      const response = await this.fetchApi(`/boards${paginatedQuery}`) as MiroBoardsResponse;
      allBoards.push(...response.data);

      if (allBoards.length >= response.total) break;
      offset += response.size;
    }

    return allBoards;
  }

  async getBoardItems(boardId: string): Promise<MiroItem[]> {
    const response = await this.fetchApi(`/boards/${boardId}/items?limit=${PAGE_LIMIT}`) as MiroItemsResponse;
    return response.data;
  }

  async createStickyNote(boardId: string, data: StickyNoteData): Promise<MiroItem> {
    return this.fetchApi(`/boards/${boardId}/sticky_notes`, {
      method: 'POST',
      body: data,
    }) as Promise<MiroItem>;
  }

  async bulkCreateItems(boardId: string, items: Record<string, unknown>[]): Promise<MiroItem[]> {
    const result = await this.fetchApi(`/boards/${boardId}/items/bulk`, {
      method: 'POST',
      body: items,
    }) as { data?: MiroItem[] };
    return result.data ?? (Array.isArray(result) ? result : []) as MiroItem[];
  }

  async getFrames(boardId: string): Promise<MiroItem[]> {
    const response = await this.fetchApi(`/boards/${boardId}/items?type=frame&limit=${PAGE_LIMIT}`) as MiroItemsResponse;
    return response.data;
  }

  async getItemsInFrame(boardId: string, frameId: string): Promise<MiroItem[]> {
    const response = await this.fetchApi(`/boards/${boardId}/items?parent_item_id=${frameId}&limit=${PAGE_LIMIT}`) as MiroItemsResponse;
    return response.data;
  }

  async createShape(boardId: string, data: ShapeData): Promise<MiroItem> {
    return this.fetchApi(`/boards/${boardId}/shapes`, {
      method: 'POST',
      body: data,
    }) as Promise<MiroItem>;
  }

  async getBoardDetails(boardId: string): Promise<MiroBoardDetails> {
    const raw = await this.fetchApi(`/boards/${boardId}`) as MiroBoardDetailsRaw;
    return this.normalizeBoardDetails(raw);
  }

  async getBoardMembers(boardId: string): Promise<MiroBoardMember[]> {
    const allMembers: MiroBoardMember[] = [];
    let offset = 0;

    while (true) {
      const query = offset > 0 ? `?limit=${PAGE_LIMIT}&offset=${offset}` : `?limit=${PAGE_LIMIT}`;
      const response = await this.fetchApi(`/boards/${boardId}/members${query}`) as MiroBoardMembersResponse;
      allMembers.push(...response.data);

      if (allMembers.length >= response.total) break;
      offset += response.size;
    }

    return allMembers;
  }

  async updateBoardSharingPolicy(boardId: string, sharingPolicy: Partial<MiroSharingPolicy>): Promise<MiroBoardDetails> {
    const raw = await this.fetchApi(`/boards/${boardId}`, {
      method: 'PATCH',
      body: { policy: { sharingPolicy } },
    }) as MiroBoardDetailsRaw;
    return this.normalizeBoardDetails(raw);
  }
}
