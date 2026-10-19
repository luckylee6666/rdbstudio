import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Secrets are consumed by the bundler and never copied into this overlay.
const env = process.env;
const mac = env.RUNNER_OS === 'macOS';
const windows = env.RUNNER_OS === 'Windows';
const apple = mac && Boolean(env.APPLE_CERTIFICATE);
if (apple && ['APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'].some((name) => !env[name])) {
  throw new Error('Apple signing was requested but identity or notarization credentials are missing');
}
const windowsSigning = windows && Boolean(env.WINDOWS_CERTIFICATE);
if (windowsSigning && !env.WINDOWS_CERTIFICATE_THUMBPRINT) {
  throw new Error('Import the Windows certificate before preparing the release');
}
const updater = Boolean(env.TAURI_SIGNING_PRIVATE_KEY);
const config = { bundle: { createUpdaterArtifacts: updater } };
if (apple) config.bundle.macOS = { signingIdentity: env.APPLE_SIGNING_IDENTITY };
if (windowsSigning) config.bundle.windows = { certificateThumbprint: env.WINDOWS_CERTIFICATE_THUMBPRINT, digestAlgorithm: 'sha256', timestampUrl: 'http://timestamp.digicert.com' };
mkdirSync('.release', { recursive: true, mode: 0o700 });
const path = resolve('.release/build.json');
writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
if (env.GITHUB_OUTPUT) {
  appendFileSync(env.GITHUB_OUTPUT, `config=${path}\nupdater=${updater}\nsigned=${apple || windowsSigning}\nmac_available=${Boolean(env.APPLE_CERTIFICATE)}\nwindows_available=${Boolean(env.WINDOWS_CERTIFICATE)}\n`);
}
console.log(`Release prepared: platform signing ${apple || windowsSigning ? 'enabled' : 'unavailable'}, signed update artifacts ${updater ? 'enabled' : 'unavailable'}.`);
