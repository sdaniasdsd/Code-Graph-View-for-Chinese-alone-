import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function isInsideProject(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
}

export function toProjectRelativePath(root: string, absolutePath: string): string {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(absolutePath);
  if (!isInsideProject(absoluteRoot, absoluteTarget)) throw new Error('文件路径位于项目目录之外。');
  return relative(absoluteRoot, absoluteTarget).split(sep).join('/');
}

export function resolveProjectPath(root: string, projectRelativePath: string): string {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(absoluteRoot, projectRelativePath.replace(/[\\/]/g, sep));
  if (!isInsideProject(absoluteRoot, absoluteTarget)) throw new Error('相对路径指向项目目录之外。');
  return absoluteTarget;
}

export function assertProjectDirectory(root: string): string {
  const absoluteRoot = resolve(root);
  try {
    if (statSync(absoluteRoot).isDirectory()) return absoluteRoot;
  } catch { /* Report a stable, user-facing path error below. */ }
  throw new Error(`工程目录不存在或不可访问：${absoluteRoot}`);
}
