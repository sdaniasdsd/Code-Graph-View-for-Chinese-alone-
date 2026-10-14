const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { assertProjectDirectory, resolveProjectPath, toProjectRelativePath } = require('../.test-build/project-paths.cjs');

test('project graph paths stay relative and identical after moving the project to another machine', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rtt-map-路径-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const firstRoot = path.join(temporary, '电脑甲', 'new-13 项目');
  const secondRoot = path.join(temporary, '电脑乙', 'new-13 项目');
  const relativeFile = 'drivers/串口 驱动/usart.c';
  const firstFile = path.join(firstRoot, ...relativeFile.split('/'));
  const secondFile = path.join(secondRoot, ...relativeFile.split('/'));
  fs.mkdirSync(path.dirname(firstFile), { recursive: true });
  fs.mkdirSync(path.dirname(secondFile), { recursive: true });
  fs.writeFileSync(firstFile, 'void init(void) {}');
  fs.writeFileSync(secondFile, 'void init(void) {}');

  const firstRelative = toProjectRelativePath(firstRoot, firstFile);
  const secondRelative = toProjectRelativePath(secondRoot, secondFile);
  assert.equal(firstRelative, relativeFile);
  assert.equal(secondRelative, relativeFile);
  assert.equal(resolveProjectPath(secondRoot, firstRelative), secondFile);
});

test('project-relative path conversion rejects paths outside the opened project', () => {
  assert.throws(() => toProjectRelativePath('C:\\work\\project', 'C:\\work\\sibling\\secret.c'), /项目目录之外/);
  assert.throws(() => resolveProjectPath('C:\\work\\project', '../secret.c'), /项目目录之外/);
});

test('stale or inaccessible recent project paths produce a clear error instead of an empty project', () => {
  assert.throws(() => assertProjectDirectory(path.join(os.tmpdir(), 'rtt-missing-project-路径')), /工程目录不存在或不可访问/);
});
