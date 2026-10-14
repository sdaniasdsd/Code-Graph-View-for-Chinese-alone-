import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = '2.56.0.2';
const archiveName = `MinGit-${version}-64-bit.zip`;
const archiveUrl = `https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/${archiveName}`;
const expectedSha256 = 'da35e72aa21c005a5a0d298cfbae110bc1609a815730ea0dde84b01a1b3cd3be';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const downloadDirectory = resolve(repoRoot, 'toolchain', 'downloads');
const archivePath = resolve(downloadDirectory, archiveName);
const toolchainPath = resolve(repoRoot, 'toolchain', 'mingit');
const markerPath = resolve(toolchainPath, '.rtt-toolchain-version');
const gitExecutable = resolve(toolchainPath, 'cmd', 'git.exe');

function ensureInsideRepository(target) {
  const relativeTarget = relative(repoRoot, target);
  if (!relativeTarget || isAbsolute(relativeTarget) || relativeTarget === '..' || relativeTarget.startsWith(`..\\`) || relativeTarget.startsWith('../')) {
    throw new Error(`拒绝操作工程目录之外的工具链路径：${target}`);
  }
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

if (existsSync(gitExecutable) && existsSync(markerPath) && readFileSync(markerPath, 'utf8').trim() === `${version} ${expectedSha256}`) {
  execFileSync(gitExecutable, ['--version'], { stdio: 'ignore', windowsHide: true });
  console.log(`已准备 MinGit ${version}`);
  process.exit(0);
}

if (process.platform !== 'win32') {
  throw new Error('当前安装包目标为 Windows x64；MinGit 工具链仅在 Windows 构建时准备。');
}

mkdirSync(downloadDirectory, { recursive: true });
if (!existsSync(archivePath) || sha256(archivePath) !== expectedSha256) {
  console.log(`正在下载官方 MinGit ${version}…`);
  const response = await fetch(archiveUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下载 MinGit 失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== expectedSha256) throw new Error(`MinGit SHA-256 不匹配，预期 ${expectedSha256}，实际 ${actualSha256}`);
  writeFileSync(archivePath, bytes);
}

if (sha256(archivePath) !== expectedSha256) throw new Error('本地 MinGit 压缩包校验失败。');
ensureInsideRepository(toolchainPath);
if (existsSync(toolchainPath)) rmSync(toolchainPath, { recursive: true, force: true });
mkdirSync(toolchainPath, { recursive: true });
const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;
const command = `Expand-Archive -LiteralPath ${quotePowerShell(archivePath)} -DestinationPath ${quotePowerShell(toolchainPath)} -Force`;
execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { stdio: 'inherit', windowsHide: true });
if (!existsSync(gitExecutable)) throw new Error('MinGit 解压成功，但缺少 cmd/git.exe。');
execFileSync(gitExecutable, ['--version'], { stdio: 'inherit', windowsHide: true });
writeFileSync(markerPath, `${version} ${expectedSha256}\n`, 'utf8');
console.log('MinGit 已就绪，将随 Windows 安装包一起分发。');
