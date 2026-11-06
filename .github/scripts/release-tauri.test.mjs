import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSigningEnvironment } from './release-tauri.mjs';

test('empty signing secrets are absent for the Tauri bundler', () => {
  const env = Object.fromEntries(['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'].map(key => [key, '']));
  env.PATH = 'fixture-path';
  normalizeSigningEnvironment(env);
  assert.deepEqual(env, { PATH: 'fixture-path' });
});

test('configured certificates and valid empty passwords are preserved', () => {
  const env = { APPLE_CERTIFICATE: 'fixture', APPLE_CERTIFICATE_PASSWORD: '', APPLE_SIGNING_IDENTITY: 'fixture identity', TAURI_SIGNING_PRIVATE_KEY: 'fixture key', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' };
  const original = { ...env };
  normalizeSigningEnvironment(env);
  assert.deepEqual(env, original);
});
