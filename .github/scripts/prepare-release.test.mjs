import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const script = resolve('.github/scripts/prepare-release.mjs');
function prepare(values) {
  const directory = mkdtempSync(join(tmpdir(), 'rdbstudio-release-'));
  const keys = ['APPLE_CERTIFICATE', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_THUMBPRINT', 'TAURI_SIGNING_PRIVATE_KEY', 'GITHUB_OUTPUT'];
  const env = { ...process.env }; keys.forEach((key) => delete env[key]); Object.assign(env, values);
  try {
    const result = spawnSync(process.execPath, [script], { cwd: directory, env, encoding: 'utf8' });
    return { result, config: result.status === 0 ? JSON.parse(readFileSync(join(directory, '.release/build.json'))) : null };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
test('unsigned builds remain available without external credentials', () => {
  const { result, config } = prepare({ RUNNER_OS: 'macOS' });
  assert.equal(result.status, 0); assert.equal(config.bundle.createUpdaterArtifacts, false); assert.equal(config.bundle.macOS, undefined);
});
test('configured macOS releases use identity and updater artifact signing', () => {
  const { result, config } = prepare({ RUNNER_OS: 'macOS', APPLE_CERTIFICATE: 'test-fixture', APPLE_SIGNING_IDENTITY: 'fixture identity', APPLE_ID: 'fixture@example.invalid', APPLE_PASSWORD: 'fixture-not-a-credential', APPLE_TEAM_ID: 'fixture-team', TAURI_SIGNING_PRIVATE_KEY: 'fixture-not-a-key' });
  assert.equal(result.status, 0); assert.equal(config.bundle.macOS.signingIdentity, 'fixture identity'); assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert(!JSON.stringify(config).includes('fixture-not-a-key')); assert(!result.stdout.includes('fixture-not-a-credential'));
});
test('incomplete requested native signing fails before invoking the bundler', () => {
  assert.notEqual(prepare({ RUNNER_OS: 'macOS', APPLE_CERTIFICATE: 'fixture' }).result.status, 0);
  assert.notEqual(prepare({ RUNNER_OS: 'Windows', WINDOWS_CERTIFICATE: 'fixture' }).result.status, 0);
});
test('Windows certificate thumbprint and timestamp are configured', () => {
  const { config } = prepare({ RUNNER_OS: 'Windows', WINDOWS_CERTIFICATE: 'fixture', WINDOWS_CERTIFICATE_THUMBPRINT: 'fixture-thumbprint' });
  assert.equal(config.bundle.windows.certificateThumbprint, 'fixture-thumbprint'); assert.equal(config.bundle.windows.digestAlgorithm, 'sha256');
});
