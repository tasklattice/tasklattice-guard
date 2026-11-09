import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function gitBuildInfo(cwd = fileURLToPath(new URL('../', import.meta.url))) {
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 3000 }).trim();
  const commit = git('rev-parse', 'HEAD');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const description = git('describe', '--tags', '--always', '--long', '--abbrev=12');
  const dirty = Boolean(git('status', '--porcelain', '--untracked-files=normal'));
  return { version: `${description}${dirty ? '-dirty' : ''}`, commit, branch: branch === 'HEAD' ? null : branch, dirty, source: 'build' };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(JSON.stringify(gitBuildInfo()));
