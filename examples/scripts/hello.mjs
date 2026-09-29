// 脚本示例。契约（§6.1）：stdin JSON 进，stdout 纯 JSON 出，日志走 stderr
async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data ? JSON.parse(data) : {};
}

try {
  const args = await readStdin();
  const who = args.who ?? 'world';
  process.stderr.write(`hello 脚本收到：${JSON.stringify(args)}\n`);
  process.stdout.write(JSON.stringify({
    status: 'ok',
    say: `打了个招呼：hello ${who}`,
    data: { who }
  }));
} catch (err) {
  process.stdout.write(JSON.stringify({
    status: 'failed',
    say: '打个招呼失败了',
    error: err.message
  }));
}
