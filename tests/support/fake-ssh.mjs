// 假 ssh（GIT_SSH_COMMAND 指过来，origin 写成 ssh://fake/<裸仓库路径>）：模拟连 origin 时网络抖动。
// FAKE_SSH_FAILS 指向一个 JSON 文件 { fetch: n, push: n }：对应方向前 n 次连接在握手时掐断（跟真 ssh 同一句报错），
// 之后在本机直接跑 git 要的那条命令（upload-pack / receive-pack），等于连上了。
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const m = /^(git-upload-pack|git-receive-pack) '(.*)'$/.exec(process.argv.at(-1) ?? '');
if (!m) {
  process.stderr.write(`fake-ssh: 不认识的命令 ${process.argv.slice(2).join(' ')}\n`);
  process.exit(2);
}
const kind = m[1] === 'git-upload-pack' ? 'fetch' : 'push';
const file = process.env.FAKE_SSH_FAILS;
const fails = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
if ((fails[kind] ?? 0) > 0) {
  fails[kind]--;
  writeFileSync(file, JSON.stringify(fails));
  process.stderr.write('kex_exchange_identification: read: Software caused connection abort\n');
  process.exit(255);
}
// Windows 上 ssh://fake/C:/x 到这里是 /C:/x
const repo = m[2].replace(/^\/([A-Za-z]:)/, '$1');
const r = spawnSync('git', [m[1].slice('git-'.length), repo], { stdio: 'inherit' });
process.exit(r.status ?? 1);
