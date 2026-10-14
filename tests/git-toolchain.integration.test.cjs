const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parsePorcelainStatusZ } = require('../.test-build/git-utils.cjs');

const git = process.env.RTT_GIT_EXECUTABLE || path.resolve('toolchain/mingit/cmd/git.exe');

test('bundled MinGit handles a project path with Chinese and spaces and reports renames', { skip: !existsSync(git) }, (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'RTT Git 路径 '));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const run = (args) => execFileSync(git, ['-C', temporary, ...args], { encoding: 'utf8', windowsHide: true });

  run(['init', '--initial-branch=main']);
  run(['config', 'user.name', 'RTT Code Map Tests']);
  run(['config', 'user.email', 'tests@example.invalid']);
  mkdirSync(path.join(temporary, 'drivers'), { recursive: true });
  writeFileSync(path.join(temporary, 'drivers', '串口 驱动.c'), 'void serial_init(void) {}\n');
  run(['add', '.']);
  run(['commit', '-m', 'initial']);
  run(['mv', 'drivers/串口 驱动.c', 'drivers/串口 驱动 新版.c']);
  writeFileSync(path.join(temporary, 'drivers', '串口 驱动 新版.c'), 'void serial_init(void) { changed(); }\n');
  writeFileSync(path.join(temporary, '未跟踪 文件.h'), '/* new */\n');

  const status = run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  assert.deepEqual(parsePorcelainStatusZ(status), ['drivers/串口 驱动 新版.c', '未跟踪 文件.h']);
});
