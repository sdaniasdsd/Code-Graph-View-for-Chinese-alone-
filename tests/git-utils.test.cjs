const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { parsePorcelainStatusZ, resolveGitExecutable } = require('../.test-build/git-utils.cjs');

test('Git porcelain -z preserves spaces and Unicode and reports renamed destination paths', () => {
  const status = ' M drivers/串口 驱动.c\0R  src/新 名称.c\0src/旧 名称.c\0?? 未跟踪 文件.h\0';
  assert.deepEqual(parsePorcelainStatusZ(status), [
    'drivers/串口 驱动.c',
    'src/新 名称.c',
    '未跟踪 文件.h',
  ]);
});

test('packaged builds prefer their bundled Git and development falls back to system Git', () => {
  const packagedGit = path.join('app-resources', 'git', 'cmd', 'git.exe');
  const devGit = path.resolve('checkout', '..', 'toolchain', 'mingit', 'cmd', 'git.exe');
  const exists = (candidate) => candidate === packagedGit || candidate === devGit;
  assert.equal(resolveGitExecutable(true, 'app-resources', 'checkout', exists), packagedGit);
  assert.equal(resolveGitExecutable(false, 'app-resources', 'checkout', exists), devGit);
  assert.equal(resolveGitExecutable(false, 'app-resources', 'checkout', () => false), 'git');
});
