import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const outputDirectory = resolve('.test-build');
mkdirSync(outputDirectory, { recursive: true });
await build({ entryPoints: ['src/electron/project-paths.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: resolve(outputDirectory, 'project-paths.cjs') });
await build({ entryPoints: ['src/electron/git-utils.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: resolve(outputDirectory, 'git-utils.cjs') });
const result = spawnSync(process.execPath, ['--test', 'tests/project-paths.test.cjs', 'tests/git-utils.test.cjs', 'tests/git-toolchain.integration.test.cjs'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
