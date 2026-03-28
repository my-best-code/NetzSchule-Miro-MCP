export interface RouteMatch {
  handler: string;
  params: Record<string, string>;
}

interface RouteDefinition {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: string;
}

function compileRoute(method: string, path: string, handler: string): RouteDefinition {
  const paramNames: string[] = [];
  const pattern = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return {
    method: method.toUpperCase(),
    pattern: new RegExp(`^${pattern}$`),
    paramNames,
    handler,
  };
}

const routes: RouteDefinition[] = [
  compileRoute('GET', '/health', 'health'),
  compileRoute('GET', '/boards', 'listBoards'),
  compileRoute('GET', '/boards/:boardId/frames', 'getFrames'),
  compileRoute('GET', '/boards/:boardId/frames/:frameId/items', 'getItemsInFrame'),
  compileRoute('GET', '/boards/:boardId/access', 'getBoardAccess'),
  compileRoute('GET', '/boards/:boardId/share-link', 'getBoardShareLink'),
  compileRoute('POST', '/boards/:boardId/sticky-notes', 'createStickyNote'),
  compileRoute('POST', '/boards/:boardId/items/bulk', 'bulkCreateItems'),
  compileRoute('POST', '/boards/:boardId/shapes', 'createShape'),
  compileRoute('PATCH', '/boards/:boardId/sharing', 'updateBoardSharing'),
];

export function matchRoute(method: string, path: string): RouteMatch | null {
  const upperMethod = method.toUpperCase();
  for (const route of routes) {
    if (route.method !== upperMethod) continue;
    const match = path.match(route.pattern);
    if (match) {
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = match[i + 1];
      });
      return { handler: route.handler, params };
    }
  }
  return null;
}
