import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MIRO_CLIENT_ID = 'test-client-id';
process.env.MIRO_CLIENT_SECRET = 'test-client-secret';

const { handler } = await import('./lambda.js');

interface TestEvent {
  requestContext: {
    http: { method: string; path: string };
    stage?: string;
    domainName?: string;
  };
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string | undefined>;
}

function makeEvent(
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): TestEvent {
  return {
    requestContext: {
      http: { method, path },
      stage: '$default',
      domainName: 'api.example.com',
    },
    headers,
    body,
  };
}

describe('OAuth proxy', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  describe('discovery', () => {
    it('advertises refresh_token grant in OIDC discovery', async () => {
      const result = await handler(
        makeEvent('GET', '/.well-known/openid-configuration'),
      );

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.grant_types_supported).toContain('authorization_code');
      expect(body.grant_types_supported).toContain('refresh_token');
      expect(body.token_endpoint).toBe('https://api.example.com/oauth/token');
    });

    it('returns refresh_token grant in client registration', async () => {
      const result = await handler(
        makeEvent(
          'POST',
          '/oauth/register',
          JSON.stringify({ client_name: 'Test', redirect_uris: [] }),
        ),
      );

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.grant_types).toContain('refresh_token');
    });
  });

  describe('token endpoint', () => {
    it('forwards refresh_token grant to Miro with injected credentials', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3599,
            token_type: 'bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

      const result = await handler(
        makeEvent(
          'POST',
          '/oauth/token',
          'grant_type=refresh_token&refresh_token=old-refresh&client_id=mcp-miro-proxy-123',
        ),
      );

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.miro.com/v1/oauth/token');
      const forwarded = new URLSearchParams(init.body as string);
      expect(forwarded.get('grant_type')).toBe('refresh_token');
      expect(forwarded.get('refresh_token')).toBe('old-refresh');
      expect(forwarded.get('client_id')).toBe('test-client-id');
      expect(forwarded.get('client_secret')).toBe('test-client-secret');

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.access_token).toBe('new-access');
      expect(body.refresh_token).toBe('new-refresh');
    });

    it('keeps real expires_in when a refresh_token is present', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'a',
            refresh_token: 'r',
            expires_in: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

      const result = await handler(
        makeEvent('POST', '/oauth/token', 'grant_type=authorization_code'),
      );

      expect(JSON.parse(result.body).expires_in).toBe(0);
    });

    it('patches expires_in for non-expiring tokens (no refresh_token)', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'a', expires_in: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const result = await handler(
        makeEvent('POST', '/oauth/token', 'grant_type=authorization_code'),
      );

      expect(JSON.parse(result.body).expires_in).toBe(31536000);
    });

    it('passes through Miro error responses', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const result = await handler(
        makeEvent(
          'POST',
          '/oauth/token',
          'grant_type=refresh_token&refresh_token=revoked',
        ),
      );

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toBe('invalid_grant');
    });

    it('does not log token or secret values', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'secret-access-value',
            refresh_token: 'secret-refresh-value',
            expires_in: 3599,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

      await handler(
        makeEvent(
          'POST',
          '/oauth/token',
          'grant_type=refresh_token&refresh_token=secret-old-refresh',
        ),
      );

      const logged = (console.log as ReturnType<typeof vi.fn>).mock.calls
        .flat()
        .join(' ');
      expect(logged).not.toContain('secret-old-refresh');
      expect(logged).not.toContain('secret-access-value');
      expect(logged).not.toContain('secret-refresh-value');
      expect(logged).not.toContain('test-client-secret');
    });
  });
});
