// Tests del ciclo de vida del callback OAuth local. El store se aísla para no
// tocar .daybeat-jira-tokens.json ni las credenciales reales del usuario.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { auth } = require('@modelcontextprotocol/sdk/client/auth.js');

const storePath = path.join(os.tmpdir(), `.daybeat-jira-test-${process.pid}.json`);
process.env.JIRA_TOKEN_STORE_PATH = storePath;

const jira = require('./jira-report.js');
const { OAuthProvider } = jira.__test;

const removeStore = () => {
  try { fs.unlinkSync(storePath); } catch (err) { /* ya no existe */ }
};

test.after(removeStore);

test('connectJira: no inicia OAuth si Jira no está configurado', async () => {
  const keys = ['ATLASSIAN_ENABLED', 'ATLASSIAN_EMAIL', 'ATLASSIAN_API_TOKEN'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];

  try {
    assert.strictEqual(jira.getStatus(), 'Jira: No configurado');
    const result = await jira.connectJira();
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /Jira no está configurado/);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('disconnectJira: cierra y limpia el estado OAuth local', async () => {
  removeStore();
  fs.writeFileSync(storePath, JSON.stringify({
    clientInformation: { client_id: 'client', redirect_uris: ['http://127.0.0.1:17890/callback'] },
    tokens: { access_token: 'access', refresh_token: 'refresh' },
    discoveryState: { authorizationServerUrl: 'https://mcp.test' }
  }));

  const result = await jira.disconnectJira();
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(storePath, 'utf8')), {});
});

test('OAuth callback: conserva la misma URL entre reinicios', async () => {
  removeStore();

  const first = await new OAuthProvider({ callbackPort: 38991 }).start();
  try {
    assert.strictEqual(first.redirectUrl, 'http://127.0.0.1:38991/callback');
    assert.deepStrictEqual(first.clientMetadata.redirect_uris, [first.redirectUrl]);
    await first.saveClientInformation({
      client_id: 'client-estable',
      redirect_uris: [first.redirectUrl]
    });
    await first.saveTokens({ access_token: 'access', refresh_token: 'refresh' });
  } finally {
    await first.close();
  }

  const second = await new OAuthProvider({ callbackPort: 38991 }).start();
  try {
    assert.strictEqual(second.redirectUrl, first.redirectUrl);
    assert.strictEqual(second.clientInformation().client_id, 'client-estable');
    assert.strictEqual(second.tokens().refresh_token, 'refresh');
  } finally {
    await second.close();
  }
});

test('OAuth callback: migra el cliente antiguo con puerto aleatorio', async () => {
  removeStore();
  fs.writeFileSync(storePath, JSON.stringify({
    clientInformation: {
      client_id: 'client-antiguo',
      redirect_uris: ['http://127.0.0.1:49123/callback']
    },
    tokens: { access_token: 'old-access', refresh_token: 'old-refresh' }
  }));

  const provider = await new OAuthProvider({ callbackPort: 38992 }).start();
  try {
    assert.strictEqual(provider.redirectUrl, 'http://127.0.0.1:38992/callback');
    assert.strictEqual(provider.clientInformation(), undefined);
    assert.strictEqual(provider.tokens(), undefined);
  } finally {
    await provider.close();
  }
});

test('OAuth flujo completo: autoriza una vez y refresca tras reiniciar', async () => {
  removeStore();

  const serverUrl = new URL('https://mcp.test/v1/mcp/authv2');
  const calls = { registrations: 0, grants: [], authorizationPrompts: 0 };
  const metadata = {
    issuer: 'https://mcp.test',
    authorization_endpoint: 'https://mcp.test/authorize',
    token_endpoint: 'https://mcp.test/token',
    registration_endpoint: 'https://mcp.test/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256']
  };

  const response = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    body: { cancel: async () => {} },
    json: async () => body,
    text: async () => JSON.stringify(body)
  });

  const fakeFetch = async (url, options = {}) => {
    const parsedUrl = new URL(url);

    if (parsedUrl.pathname.includes('oauth-protected-resource')) return response({}, 404);
    if (parsedUrl.pathname === '/.well-known/oauth-authorization-server') return response(metadata);

    if (parsedUrl.pathname === '/register') {
      calls.registrations += 1;
      const requested = JSON.parse(options.body);
      return response({
        client_id: 'fake-client',
        redirect_uris: requested.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: requested.grant_types,
        response_types: requested.response_types
      });
    }

    if (parsedUrl.pathname === '/token') {
      const params = new URLSearchParams(options.body);
      calls.grants.push(params.get('grant_type'));
      if (params.get('grant_type') === 'authorization_code') {
        return response({ access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer' });
      }
      if (params.get('grant_type') === 'refresh_token') {
        return response({ access_token: 'access-2', token_type: 'Bearer' });
      }
    }

    throw new Error(`fetch OAuth inesperado: ${url}`);
  };

  const first = await new OAuthProvider({ callbackPort: 38993 }).start();
  try {
    let authorizationUrl = null;
    first.redirectToAuthorization = async (url) => {
      calls.authorizationPrompts += 1;
      authorizationUrl = String(url);
    };

    const redirectResult = await auth(first, { serverUrl, fetchFn: fakeFetch });
    assert.strictEqual(redirectResult, 'REDIRECT');
    assert.strictEqual(new URL(authorizationUrl).searchParams.get('redirect_uri'), first.redirectUrl);
    assert.strictEqual(calls.authorizationPrompts, 1);

    const tokenResult = await auth(first, {
      serverUrl,
      authorizationCode: 'authorization-code',
      fetchFn: fakeFetch
    });
    assert.strictEqual(tokenResult, 'AUTHORIZED');
    assert.strictEqual(first.tokens().refresh_token, 'refresh-1');
  } finally {
    await first.close();
  }

  const second = await new OAuthProvider({ callbackPort: 38993 }).start();
  try {
    second.redirectToAuthorization = async () => {
      throw new Error('No debe solicitar autorización al reiniciar');
    };
    const refreshResult = await auth(second, { serverUrl, fetchFn: fakeFetch });
    assert.strictEqual(refreshResult, 'AUTHORIZED');
    assert.strictEqual(second.tokens().access_token, 'access-2');
    assert.strictEqual(calls.registrations, 1);
    assert.deepStrictEqual(calls.grants, ['authorization_code', 'refresh_token']);
  } finally {
    await second.close();
  }
});
