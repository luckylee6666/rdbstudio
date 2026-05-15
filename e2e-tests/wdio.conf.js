import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// tauri-driver child process handle (kept in module scope so afterSession can kill it)
let tauriDriver;

export const config = {
    runner: 'local',
    hostname: '127.0.0.1',
    port: 4444,
    specs: ['./specs/**/*.spec.js'],
    maxInstances: 1,
    capabilities: [
        {
            browserName: 'wry',
            'tauri:options': {
                application: resolve(
                    __dirname,
                    '..',
                    'src-tauri',
                    'target',
                    'release',
                    'rdbstudio'
                ),
            },
        },
    ],
    logLevel: 'info',
    bail: 0,
    waitforTimeout: 10_000,
    connectionRetryTimeout: 120_000,
    connectionRetryCount: 3,
    framework: 'mocha',
    reporters: ['spec'],
    mochaOpts: {
        ui: 'bdd',
        timeout: 60_000,
    },

    // Ensure the Tauri app binary is built in release mode before the first session.
    onPrepare: function () {
        const manifest = resolve(__dirname, '..', 'src-tauri', 'Cargo.toml');
        const result = spawnSync(
            'cargo',
            ['build', '--release', '--manifest-path', manifest],
            { stdio: 'inherit' }
        );
        if (result.status !== 0) {
            throw new Error(
                `cargo build --release failed with exit code ${result.status}`
            );
        }
    },

    // Spawn tauri-driver on port 4444 and wait until it is listening.
    beforeSession: function () {
        return new Promise((resolvePromise, rejectPromise) => {
            tauriDriver = spawn('tauri-driver', [], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    try { tauriDriver.kill(); } catch { /* ignore */ }
                    rejectPromise(new Error('tauri-driver did not report "listening" within 30s'));
                }
            }, 30_000);

            const onData = (chunk) => {
                const text = chunk.toString();
                process.stdout.write(`[tauri-driver] ${text}`);
                if (!settled && text.toLowerCase().includes('listening')) {
                    settled = true;
                    clearTimeout(timer);
                    resolvePromise();
                }
            };

            tauriDriver.stdout.on('data', onData);
            tauriDriver.stderr.on('data', onData);
            tauriDriver.on('error', (err) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    rejectPromise(err);
                }
            });
            tauriDriver.on('exit', (code) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    rejectPromise(new Error(`tauri-driver exited early with code ${code}`));
                }
            });
        });
    },

    afterSession: function () {
        if (tauriDriver) {
            try { tauriDriver.kill(); } catch { /* ignore */ }
            tauriDriver = undefined;
        }
    },
};
