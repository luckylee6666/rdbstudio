import { pathToFileURL } from 'node:url';

// Tauri treats an existing empty certificate variable as a configured certificate.
export function normalizeSigningEnvironment(env) {
  if (!env.APPLE_CERTIFICATE) {
    delete env.APPLE_CERTIFICATE;
    delete env.APPLE_CERTIFICATE_PASSWORD;
  }
  for (const key of ['APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'TAURI_SIGNING_PRIVATE_KEY']) {
    if (!env[key]) delete env[key];
  }
  if (!env.TAURI_SIGNING_PRIVATE_KEY) delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  normalizeSigningEnvironment(process.env);
  const { run } = await import('@tauri-apps/cli');
  await run(process.argv.slice(2), 'node .github/scripts/release-tauri.mjs');
}
