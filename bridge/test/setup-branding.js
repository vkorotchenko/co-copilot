#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const scratch = path.join(__dirname, `.setup-branding-scratch-${process.pid}`);
const previousCopilotHome = process.env.COPILOT_HOME;
const previousHome = process.env.HOME;
const previousPath = process.env.PATH;
const previousServiceLog = process.env.SETUP_SERVICE_LOG;
process.env.COPILOT_HOME = scratch;
process.env.HOME = scratch;

const configPath = path.join(scratch, 'mcp-config.json');
const serviceLog = path.join(scratch, 'service-commands.log');
const binDir = path.join(scratch, 'bin');

try {
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const commandStub = [
    `#!${process.execPath}`,
    "'use strict';",
    "const fs = require('fs');",
    "fs.appendFileSync(process.env.SETUP_SERVICE_LOG, `${process.argv[1]} ${process.argv.slice(2).join(' ')}\\n`);",
    '',
  ].join('\n');
  for (const command of ['launchctl', 'systemctl']) {
    const commandPath = path.join(binDir, command);
    fs.writeFileSync(commandPath, commandStub);
    fs.chmodSync(commandPath, 0o755);
  }
  process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;
  process.env.SETUP_SERVICE_LOG = serviceLog;

  const setup = require('../scripts/setup');
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      existing: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      [setup.LEGACY_MCP_NAME]: { type: 'http', url: 'http://127.0.0.1:4317/mcp' },
    },
  }));

  setup.registerMcp();
  let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepStrictEqual(config.mcpServers.existing, {
    type: 'http',
    url: 'http://127.0.0.1:9999/mcp',
  });
  assert.strictEqual(config.mcpServers[setup.LEGACY_MCP_NAME], undefined);
  assert.deepStrictEqual(config.mcpServers[setup.MCP_NAME], {
    type: 'http',
    url: 'http://127.0.0.1:4317/mcp',
    tools: ['*'],
  });

  assert.match(setup.macPlist(), new RegExp(`<string>${setup.LABEL}</string>`));
  assert.match(setup.macPlist(), /co-copilot-bridge\.log/);
  assert.match(setup.systemdUnit(), /Description=co-copilot bridge/);
  assert.strictEqual(setup.MCP_NAME, 'co-copilot');
  assert.strictEqual(setup.UNIT, 'co-copilot-bridge.service');

  const legacyPlist = path.join(
    scratch, 'Library', 'LaunchAgents', `${setup.LEGACY_LABEL}.plist`,
  );
  fs.mkdirSync(path.dirname(legacyPlist), { recursive: true });
  fs.writeFileSync(legacyPlist, 'legacy launchd service');
  setup.migrateLegacyService('darwin');
  assert.strictEqual(fs.existsSync(legacyPlist), false);

  const legacyUnit = path.join(
    scratch, '.config', 'systemd', 'user', setup.LEGACY_UNIT,
  );
  fs.mkdirSync(path.dirname(legacyUnit), { recursive: true });
  fs.writeFileSync(legacyUnit, 'legacy systemd service');
  setup.migrateLegacyService('linux');
  assert.strictEqual(fs.existsSync(legacyUnit), false);

  const commands = fs.readFileSync(serviceLog, 'utf8');
  assert.match(
    commands,
    new RegExp(`launchctl bootout gui/\\d+/${setup.LEGACY_LABEL.replace(/\./g, '\\.')}`),
  );
  assert.match(
    commands,
    new RegExp(`systemctl --user disable --now ${setup.LEGACY_UNIT.replace(/\./g, '\\.')}`),
  );
  assert.match(commands, /systemctl --user daemon-reload/);

  setup.unregisterMcp();
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepStrictEqual(config.mcpServers, {
    existing: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
  });

  console.log(
    'PASS: setup uses co-copilot identities and removes pre-rename MCP and service artifacts',
  );
} finally {
  if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = previousCopilotHome;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (previousServiceLog === undefined) delete process.env.SETUP_SERVICE_LOG;
  else process.env.SETUP_SERVICE_LOG = previousServiceLog;
  fs.rmSync(scratch, { recursive: true, force: true });
}
