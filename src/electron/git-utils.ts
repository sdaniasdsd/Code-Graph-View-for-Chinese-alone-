import { resolve, join } from 'node:path';

export function resolveGitExecutable(
  isPackaged: boolean,
  resourcesPath: string,
  appDirectory: string,
  exists: (path: string) => boolean,
): string {
  const bundled = isPackaged
    ? join(resourcesPath, 'git', 'cmd', 'git.exe')
    : resolve(appDirectory, '../toolchain/mingit/cmd/git.exe');
  return exists(bundled) ? bundled : 'git';
}

export function parsePorcelainStatusZ(output: string): string[] {
  const records = output.split('\0');
  const changedFiles: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const filePath = record.slice(3).replaceAll('\\', '/');
    if (filePath) changedFiles.push(filePath);
    // In -z mode Git emits the original name as a second NUL-delimited field.
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return [...new Set(changedFiles)];
}
