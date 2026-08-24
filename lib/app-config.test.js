// Tests de lib/app-config.js: migración desde .env, prioridad de la config
// sobre el .env, setup completo y limpieza de env al desactivar integraciones.
// El archivo se aísla en un path temporal (APP_CONFIG_PATH) y se restauran las
// variables de entorno al terminar.

const fs = require('fs');
const os = require('os');
const path = require('path');

const configPath = path.join(os.tmpdir(), `.daybeat-config-test-${process.pid}.json`);
process.env.APP_CONFIG_PATH = configPath;

const test = require('node:test');
const assert = require('node:assert');
const appConfig = require('./app-config.js');

const ENV_KEYS = [
  'LINK_DAYBEAT', 'COMPANY', 'USERNAME_DAYBEAT', 'PASSWORD',
  'ROOT_DIR', 'GIT_AUTHOR_EMAIL', 'HEADLESS',
  'ATLASSIAN_ENABLED', 'ATLASSIAN_EMAIL', 'ATLASSIAN_API_TOKEN'
];

const previousEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const setEnv = (values) => {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

const clearEnv = () => setEnv(Object.fromEntries(ENV_KEYS.map((k) => [k, undefined])));

const writeConfig = (data) => fs.writeFileSync(configPath, JSON.stringify(data, null, 2));

test.after(() => {
  try { fs.unlinkSync(configPath); } catch (err) { /* ya no existe */ }
  setEnv(previousEnv);
});

test('initialize: migra .env a .daybeat-config.json la primera vez', () => {
  try { fs.unlinkSync(configPath); } catch (err) { /* ya no existe */ }
  clearEnv();
  setEnv({
    LINK_DAYBEAT: 'https://daybeat.example.com',
    COMPANY: 'ACME',
    USERNAME_DAYBEAT: 'juan',
    PASSWORD: 'secreta',
    ROOT_DIR: '/home/user/repos',
    GIT_AUTHOR_EMAIL: 'juan@example.com',
    HEADLESS: 'true',
    ATLASSIAN_ENABLED: 'true'
  });

  appConfig.initialize();

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.strictEqual(raw.daybeat.link, 'https://daybeat.example.com');
  assert.strictEqual(raw.daybeat.company, 'ACME');
  assert.strictEqual(raw.daybeat.username, 'juan');
  assert.strictEqual(raw.daybeat.password, 'secreta');
  assert.strictEqual(raw.git.rootDir, '/home/user/repos');
  assert.strictEqual(raw.git.authorEmail, 'juan@example.com');
  assert.strictEqual(raw.preferences.headless, true);
  assert.strictEqual(raw.integrations.jira, true);
  assert.strictEqual(raw.setupCompleted, true);
  assert.strictEqual(appConfig.isSetupComplete(), true);
});

test('la config del archivo manda sobre el .env', () => {
  writeConfig({
    version: 1,
    setupCompleted: true,
    daybeat: { link: 'https://otra-url', company: 'OTRA', username: 'pepe', password: 'pass2' },
    git: { rootDir: '', authorEmail: '' },
    preferences: { headless: false },
    integrations: { jira: false }
  });
  appConfig.reload();
  setEnv({
    LINK_DAYBEAT: 'https://desde-env',
    COMPANY: 'ENV',
    USERNAME_DAYBEAT: 'env-user',
    PASSWORD: 'env-pass',
    HEADLESS: 'true',
    ATLASSIAN_ENABLED: 'true',
    ATLASSIAN_EMAIL: 'a@b.com',
    ATLASSIAN_API_TOKEN: 'tok'
  });

  appConfig.syncEnv();

  assert.strictEqual(process.env.LINK_DAYBEAT, 'https://otra-url');
  assert.strictEqual(process.env.COMPANY, 'OTRA');
  assert.strictEqual(process.env.USERNAME_DAYBEAT, 'pepe');
  assert.strictEqual(process.env.PASSWORD, 'pass2');
  assert.strictEqual(process.env.HEADLESS, undefined);
  assert.strictEqual(process.env.ATLASSIAN_ENABLED, undefined);
  assert.strictEqual(process.env.ATLASSIAN_EMAIL, undefined);
  assert.strictEqual(process.env.ATLASSIAN_API_TOKEN, undefined);
});

test('setup incompleto bloquea hasta completar Daybeat', () => {
  writeConfig({
    version: 1,
    daybeat: { link: 'https://x', company: '', username: '', password: '' },
    git: { rootDir: '', authorEmail: '' },
    preferences: { headless: false },
    integrations: { jira: false }
  });
  appConfig.reload();
  assert.strictEqual(appConfig.isSetupComplete(), false);

  appConfig.setDaybeat({ company: 'ACME', username: 'juan', password: 'pass' });
  assert.strictEqual(appConfig.isSetupComplete(), true);
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.strictEqual(raw.setupCompleted, true);
});

test('setJiraEnabled(false) limpia los flags de Jira del env', () => {
  writeConfig({
    version: 1,
    setupCompleted: true,
    daybeat: { link: 'l', company: 'c', username: 'u', password: 'p' },
    git: { rootDir: '', authorEmail: '' },
    preferences: { headless: false },
    integrations: { jira: true }
  });
  appConfig.reload();
  setEnv({ ATLASSIAN_ENABLED: 'true', ATLASSIAN_EMAIL: 'a@b.com', ATLASSIAN_API_TOKEN: 'tok' });
  appConfig.syncEnv();
  assert.strictEqual(process.env.ATLASSIAN_ENABLED, 'true');

  appConfig.setJiraEnabled(false);

  assert.strictEqual(process.env.ATLASSIAN_ENABLED, undefined);
  assert.strictEqual(process.env.ATLASSIAN_EMAIL, undefined);
  assert.strictEqual(process.env.ATLASSIAN_API_TOKEN, undefined);
  assert.strictEqual(appConfig.isJiraEnabled(), false);
});
