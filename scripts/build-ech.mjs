import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(new URL('../bin/', import.meta.url), { recursive: true });
const binary = fileURLToPath(
  new URL(`../bin/kazumi-ech${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url),
);
const result = spawnSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', binary, '.'], {
  cwd: `${root}native/ech`,
  env: { ...process.env, CGO_ENABLED: '0' },
  stdio: 'inherit',
});
if (result.error) console.error('构建 ECH 工具需要 Go 1.23 或更新版本：', result.error.message);
if (result.status === 0) {
  const goRoot = spawnSync('go', ['env', 'GOROOT'], { encoding: 'utf8' });
  if (goRoot.status === 0) {
    const goDirectory = goRoot.stdout.trim();
    // Homebrew keeps the license beside libexec rather than inside GOROOT.
    const license = [join(goDirectory, 'LICENSE'), join(goDirectory, '..', 'LICENSE')].find(
      existsSync,
    );
    if (!license) throw new Error('Go 安装目录中缺少 LICENSE');
    copyFileSync(license, new URL('../bin/GO-LICENSE', import.meta.url));
  }
}
process.exitCode = result.status ?? 1;
