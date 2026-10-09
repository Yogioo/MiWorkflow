// 工单源接口 ticket_ready / ticket_view / ticket_mark 的契约测试（GitHub 实现，假 gh）。脚手架在 tests/support/github-template.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setup, issue, issueState, labelsOf, comments, readState, runScript, spawnScript, fetchLog } from './support/github-template.mjs';

const keys = (o) => Object.keys(o).sort();
const PNG = '89504e470d0a1a0a00';
const JPG = 'ffd8ffe000';

test('ticket_ready：入 {}，出 ready / blocked；工单号是字符串，引用是 #N；按优先级 → 工单号排序', () => {
  const s = setup({
    issues: [
      issue(1, { title: '前置' }),
      issue(3, { title: '低优先', labels: ['ready-for-agent', 'P3'] }),
      issue(5, { title: '被挡', body: '- [ ] #1\n- [x] #2', labels: ['ready-for-agent'] }),
      issue(8, { title: '在跑', labels: ['ready-for-agent', 'afk-claimed'] }),
      issue(9, { title: '高优先', labels: ['ready-for-agent', 'P0'] }),
      issue(10, { title: '依赖已关', body: '- [ ] #4', labels: ['ready-for-agent'] }),
      issue(11, { title: '已交付未关', labels: ['ready-for-agent', 'afk-delivered'] }),
      issue(12, { title: '依赖已交付', body: '- [ ] #11', labels: ['ready-for-agent'] }),
      issue(13, { title: '失败', labels: ['ready-for-agent', 'afk-failed'] })
    ]
  });

  const r = runScript(s, 'ticket_ready', {});
  assert.equal(r.status, 'ok', r.error);
  assert.deepEqual(keys(r.data), ['blocked', 'ready']);
  assert.deepEqual(r.data.ready, [
    { id: '9', ref: '#9', title: '高优先', priority: 0 },
    { id: '10', ref: '#10', title: '依赖已关', priority: 2 },
    { id: '12', ref: '#12', title: '依赖已交付', priority: 2 },
    { id: '3', ref: '#3', title: '低优先', priority: 3 }
  ], '前置关单或贴 afk-delivered 都算满足；带任一机器标签的不入队');
  assert.equal(r.data.blocked.length, 1);
  const [b] = r.data.blocked;
  assert.deepEqual(keys(b), ['id', 'reason', 'ref']);
  assert.equal(b.id, '5');
  assert.equal(b.ref, '#5');
  assert.match(b.reason, /#1/, 'reason 写明被哪张单挡住');
  assert.doesNotMatch(b.reason, /#2/, '勾上的依赖不算');
});

test('ticket_view：入 { id }，出 { id, ref, title, file, review }；快照在本次运行日志目录下，带正文与全部评论', () => {
  const s = setup({ issues: [issue(7, { title: '读我', body: '正文内容' })] });
  runScript(s, 'ticket_mark', { id: '7', action: 'failed', comment: '上次挂了' });

  const r = runScript(s, 'ticket_view', { id: '7' }, { AGENTFLOW_RUN_ID: 'run-1' });
  assert.equal(r.status, 'ok', r.error);
  assert.deepEqual(keys(r.data), ['claim', 'file', 'id', 'labels', 'ref', 'review', 'title']);
  assert.deepEqual(r.data.labels, ['afk-failed'], '出参给出机器标签（校验用）');
  assert.equal(r.data.claim, null, '没人接过的单：有效接单人是 null');
  assert.equal(r.data.id, '7');
  assert.equal(r.data.ref, '#7');
  assert.equal(r.data.title, '读我');
  assert.equal(r.data.review, false, '没贴要审查标签');
  assert.equal(r.data.file, path.join(s.home, 'logs', 'run-1', 'tickets', '7', 'ticket.md'));
  const md = readFileSync(r.data.file, 'utf8');
  assert.match(md, /^# #7 读我/);
  assert.match(md, /正文内容/);
  assert.match(md, /上次挂了/);
  assert.equal(fetchLog(s).length, 0, '没图就不发请求');

  assert.equal(runScript(s, 'ticket_view', {}).status, 'failed', '缺 id');
  assert.equal(runScript(s, 'ticket_view', { id: 'abc' }).status, 'failed', '工单号不对');
});

test('ticket_view：正文 + 评论里的图片下载到 images/、按魔数定扩展名、改写成相对路径；令牌不跟到重定向后的主机', () => {
  const GH = 'https://github.com/user-attachments/assets/aaa';
  const S3 = 'https://s3.example.com/signed?x=1';
  const s = setup({
    issues: [issue(3, { body: `看图 ![截图](${GH})\n再看 <img width="200" alt="界面" src="https://img.example.com/b.png">` })],
    fetchRoutes: {
      [GH]: { needsAuth: true, location: S3 },
      [S3]: { bytes: PNG },
      'https://img.example.com/b.png': { bytes: JPG },
      'https://img.example.com/c.gif': { bytes: '4749463839' }
    }
  });
  const st = readState(s);
  st.issues[0].comments.push({ author: 'human', at: 't', body: `评论里的图 ![c](https://img.example.com/c.gif) 与重复的 ![again](${GH})` });
  writeFileSync(s.stateFile, JSON.stringify(st));

  const r = runScript(s, 'ticket_view', { id: '3' });
  assert.equal(r.status, 'ok', r.error);
  const dir = path.dirname(r.data.file);
  const md = readFileSync(r.data.file, 'utf8');
  assert.match(md, /!\[截图\]\(images\/1\.png\)/);
  assert.match(md, /!\[界面\]\(images\/2\.jpg\)/, '扩展名看内容，不看 URL');
  assert.match(md, /!\[c\]\(images\/3\.gif\)/);
  assert.match(md, /!\[again\]\(images\/1\.png\)/, '同一张图只下一次');
  assert.doesNotMatch(md, /https:\/\//);
  assert.deepEqual(readdirSync(path.join(dir, 'images')).sort(), ['1.png', '2.jpg', '3.gif']);

  const log = fetchLog(s);
  assert.equal(log.find((l) => l.url === GH).auth, 'Bearer fake-token', 'github.com 带令牌');
  assert.equal(log.find((l) => l.url === S3).auth, null, '令牌不发往重定向后的地址');
  assert.ok(log.filter((l) => l.url !== GH).every((l) => l.auth === null));
});

test('ticket_view：超过 30 张只下 30 张并写明还有 N 张；单张下载失败留占位、整单照样成功', () => {
  const urls = Array.from({ length: 32 }, (_, i) => `https://img.example.com/${i}.png`);
  const routes = Object.fromEntries(urls.map((u) => [u, { bytes: PNG }]));
  delete routes[urls[1]];
  const s = setup({ issues: [issue(4, { body: urls.map((u) => `![](${u})`).join('\n') })], fetchRoutes: routes });

  const r = spawnScript(s, 'ticket_view', { id: '4' });
  assert.equal(r.out.status, 'ok', r.out.error);
  const md = readFileSync(r.out.data.file, 'utf8');
  assert.match(md, /还有 2 张图片未下载/);
  assert.match(md, new RegExp(`图片未能下载：${urls[1].replace(/[.]/g, '\\.')}`));
  assert.match(md, /!\[\]\(images\/29\.png\)/, '失败的那张不占编号');
  assert.ok(md.includes(`![](${urls[31]})`), '超出的保留原链接');
  assert.equal(fetchLog(s).length, 30);
  assert.equal(readdirSync(path.join(path.dirname(r.out.data.file), 'images')).length, 29);
  assert.match(r.stderr, /图片下载失败 .*1\.png：HTTP 404/);
  assert.equal(r.stderr.trim().split('\n').length, 1, 'stderr 只一行');
});

test('ticket_mark：入 { id, action, comment?, sha? }；四种 action 按 GitHub 规则落标签 / 评论 / 关单；comment 原样发', () => {
  const s = setup({ issues: [1, 2, 3].map((n) => issue(n, { labels: ['ready-for-agent'] })), repoLabels: ['ready-for-agent'] });

  const claimed = runScript(s, 'ticket_mark', { id: '1', action: 'claimed', worker: 'wt1' });
  assert.equal(claimed.status, 'ok', claimed.error);
  assert.equal(claimed.data.id, '1');
  assert.equal(claimed.data.ref, '#1');
  assert.deepEqual(labelsOf(s, 1), ['ready-for-agent', 'afk-claimed'], '仓库里没有的标签先建再贴');
  assert.equal(comments(issueState(s, 1)), '[miworkflow:claim worker=wt1]', '认领要发一条带工人名的接单评论');

  assert.equal(runScript(s, 'ticket_mark', { id: '1', action: 'done', sha: 'abc123' }).status, 'ok');
  assert.equal(issueState(s, 1).state, 'CLOSED');
  assert.deepEqual(labelsOf(s, 1), ['afk-delivered']);
  assert.match(comments(issueState(s, 1)), /提交：abc123/);

  runScript(s, 'ticket_mark', { id: '2', action: 'claimed', worker: 'wt1' });
  assert.equal(runScript(s, 'ticket_mark', { id: '2', action: 'unpushed', sha: 'def456' }).status, 'ok');
  assert.equal(issueState(s, 2).state, 'OPEN');
  assert.deepEqual(labelsOf(s, 2), ['ready-for-agent', 'afk-claimed'], '未推送不动标签');
  assert.match(comments(issueState(s, 2)), /未推送.*def456/);

  runScript(s, 'ticket_mark', { id: '3', action: 'claimed', worker: 'wt1' });
  assert.equal(runScript(s, 'ticket_mark', { id: '3', action: 'failed', comment: '原因' }).status, 'ok');
  assert.deepEqual(labelsOf(s, 3), ['ready-for-agent', 'afk-failed']);
  assert.equal(issueState(s, 3).comments.at(-1).body, '[miworkflow:failed]\n\n原因', '调用方给整段评论，前面贴状态标记、不截断');

  assert.equal(runScript(s, 'ticket_mark', { id: '3', action: 'nope' }).status, 'failed');
  assert.equal(runScript(s, 'ticket_mark', { action: 'claimed', worker: 'wt1' }).status, 'failed', '缺 id');
});

test('ticket_mark commentFile：带图回帖稿 → gh 在回帖稿目录执行、--attach 与正文引用逐字一致；备份 ref 那句话保留', () => {
  const s = setup({ issues: [issue(1)] });
  const dir = path.join(s.base, 'tickets', '1');
  mkdirSync(path.join(dir, 'images'), { recursive: true });
  writeFileSync(path.join(dir, 'images', 'red.png'), Buffer.from(PNG, 'hex'));
  writeFileSync(path.join(dir, 'blue.png'), Buffer.from(PNG, 'hex'));
  const md = '看图：\n\n![红](images/red.png)\n<img alt="蓝" src="./blue.png">\n![外链](https://x.example/a.png)\n';
  writeFileSync(path.join(dir, 'reply-1.md'), md);

  const r = runScript(s, 'ticket_mark', { id: '1', action: 'failed', comment: 'afk failed：挂了\n（回滚掉的 1 笔提交备份在 refs/afk/backup/x：abc）', commentFile: path.join(dir, 'reply-1.md') });
  assert.equal(r.status, 'ok', r.error);
  const st = readState(s);
  assert.equal(st.versionChecks, 1);
  const [c] = st.issues[0].comments;
  assert.equal(path.resolve(c.cwd), path.resolve(dir), 'gh 的 cwd 是回帖稿目录');
  assert.deepEqual(c.attach, ['images/red.png', './blue.png']);
  assert.equal(c.body, `[miworkflow:failed]\n\nafk failed：挂了\n（回滚掉的 1 笔提交备份在 refs/afk/backup/x：abc）\n\n${md}`);

  assert.equal(runScript(s, 'ticket_mark', { id: '1', action: 'done', sha: 'abc', commentFile: path.join(dir, 'reply-1.md') }).status, 'ok');
  assert.equal(readState(s).issues[0].comments.at(-1).body, `[miworkflow:done]\n\n${md}`, 'done 也带回帖稿；只给 commentFile 时评论就是标记 + 回帖稿原文');
});

test('ticket_mark commentFile：不带图不查版本；gh 版本过低 → 图片换成降级文案、say 提示升级、评论照发', () => {
  const s = setup({ issues: [issue(1), issue(2)] });
  const st0 = readState(s); st0.ghVersion = '2.97.0'; writeFileSync(s.stateFile, JSON.stringify(st0));
  const dir = path.join(s.base, 'r');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'plain.md'), '只有字');
  writeFileSync(path.join(dir, 'red.png'), Buffer.from(PNG, 'hex'));
  writeFileSync(path.join(dir, 'img.md'), '看 ![红](red.png) 这里');

  assert.equal(runScript(s, 'ticket_mark', { id: '1', action: 'failed', comment: 'a', commentFile: path.join(dir, 'plain.md') }).status, 'ok');
  assert.equal(readState(s).versionChecks ?? 0, 0, '不带图不查版本');
  assert.equal(issueState(s, 1).comments[0].body, '[miworkflow:failed]\n\na\n\n只有字');

  const r = runScript(s, 'ticket_mark', { id: '2', action: 'failed', comment: 'b', commentFile: path.join(dir, 'img.md') });
  assert.equal(r.status, 'ok', r.error);
  assert.match(r.say, /2\.97\.0.*升级 gh/);
  const [c] = issueState(s, 2).comments;
  assert.deepEqual(c.attach, []);
  assert.equal(c.body, '[miworkflow:failed]\n\nb\n\n看 （图片未上传：red.png） 这里');
  assert.deepEqual(labelsOf(s, 2), ['afk-failed']);

  assert.equal(runScript(s, 'ticket_mark', { id: '1', action: 'failed', comment: 'c', commentFile: path.join(dir, 'none.md') }).status, 'ok');
  assert.equal(issueState(s, 1).comments.at(-1).body, '[miworkflow:failed]\n\nc', '没写回帖稿就只发 comment');
  assert.equal(runScript(s, 'ticket_mark', { id: '1', action: 'failed' }).status, 'ok');
  assert.equal(issueState(s, 1).comments.at(-1).body, '[miworkflow:failed]\n\nafk failed', '什么都没给才用缺省一句');
});
