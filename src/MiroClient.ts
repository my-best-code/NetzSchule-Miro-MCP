
import fetch from 'node-fetch';

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

interface MiroSharingPolicy {
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

export class MiroClient {
  constructor(private token: string) {}

  private async fetchApi(path: string, options: { method?: string; body?: any } = {}) {
    const response = await fetch(`https://api.miro.com/v2${path}`, {
      method: options.method || 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    
    if (!response.ok) {
      throw new Error(`Miro API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async getTokenContext(): Promise<MiroTokenContext> {
    const response = await fetch('https://api.miro.com/v1/oauth-token', {
      headers: {
        'Authorization': `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Miro API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<MiroTokenContext>;
  }

  async getBoards(params?: BoardFilterParams): Promise<MiroBoard[]> {
    const queryParts: string[] = ['limit=50'];
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
    const response = await this.fetchApi(`/boards/${boardId}/items?limit=50`) as MiroItemsResponse;
    return response.data;
  }

  async createStickyNote(boardId: string, data: any): Promise<MiroItem> {
    return this.fetchApi(`/boards/${boardId}/sticky_notes`, {
      method: 'POST',
      body: data
    }) as Promise<MiroItem>;
  }

  async bulkCreateItems(boardId: string, items: any[]): Promise<MiroItem[]> {
    const response = await fetch(`https://api.miro.com/v2/boards/${boardId}/items/bulk`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(items)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Miro API error: ${response.status} ${response.statusText} — ${errorText}`);
    }

    const result = await response.json() as { data?: MiroItem[] };
    return result.data ?? (Array.isArray(result) ? result : []) as MiroItem[];
  }

  async getFrames(boardId: string): Promise<MiroItem[]> {
    const response = await this.fetchApi(`/boards/${boardId}/items?type=frame&limit=50`) as MiroItemsResponse;
    return response.data;
  }

  async getItemsInFrame(boardId: string, frameId: string): Promise<MiroItem[]> {
    const response = await this.fetchApi(`/boards/${boardId}/items?parent_item_id=${frameId}&limit=50`) as MiroItemsResponse;
    return response.data;
  }

  async createShape(boardId: string, data: any): Promise<MiroItem> {
    return this.fetchApi(`/boards/${boardId}/shapes`, {
      method: 'POST',
      body: data
    }) as Promise<MiroItem>;
  }

  async getBoardDetails(boardId: string): Promise<MiroBoardDetails> {
    const raw = await this.fetchApi(`/boards/${boardId}`) as MiroBoardDetailsRaw;
    return {
      ...raw,
      sharingPolicy: raw.sharingPolicy ?? raw.policy?.sharingPolicy,
      permissionsPolicy: raw.permissionsPolicy ?? raw.policy?.permissionsPolicy,
    };
  }

  async getBoardMembers(boardId: string): Promise<MiroBoardMember[]> {
    const allMembers: MiroBoardMember[] = [];
    let offset = 0;

    while (true) {
      const query = offset > 0 ? `?limit=50&offset=${offset}` : '?limit=50';
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
      body: { policy: { sharingPolicy } }
    }) as MiroBoardDetailsRaw;
    return {
      ...raw,
      sharingPolicy: raw.sharingPolicy ?? raw.policy?.sharingPolicy,
      permissionsPolicy: raw.permissionsPolicy ?? raw.policy?.permissionsPolicy,
    };
  }
}