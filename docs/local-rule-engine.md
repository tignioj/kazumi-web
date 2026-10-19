# 本地规则引擎、兼容性与性能

生产服务在 Node 内执行 XPath / API 9 规则，并优先静态提取视频。需要执行页面脚本或验证码时，才启动 Chromium。Compose 和发布流程只有 `kazumi-web`；不下载或启动官方 Flutter 应用。

本次迁移以 `0a560d76555633d20609744cc8d5feb368079c35` 为基线，按模块恢复 `1a3f695` 之前的实现，保留之后的业务与网络修复，没有整次回退提交。

## 实现边界

- [规则引擎](../server/modules/rules/engine.js)：XPath、受限 JSONPath、GET/POST、JSON/form、API 9 来源模板、嵌套和分隔文本章节、剧集 URL 归一化。
- [视频解析](../server/modules/playback/source-resolver.js)：直链、媒体元素、MacCMS 元数据、有限层数的 iframe；保留已有 HHJX 和 7sefun 适配。
- [浏览器](../server/modules/playback/browser-resolver.js)：通用嗅探、规则验证码、访问者 Cookie/UA 隔离、媒体预检、最多两个并发任务；排队最多 30 秒，支持取消。空闲 30 秒后关闭浏览器，已验证的 Cookie 会话仍留在 Node 内存。
- [媒体传输](../server/modules/playback/media.js)：沿用服务端媒体会话、Range、无扩展名格式识别、HLS 同源重写和下载接口。客户端签名链接不包含来源凭据。

保留四源并发及流式搜索、超时后的已完成结果、单来源重试、断连重试一次和分类错误；保留现有分流、代理出口、ECH、DNS/重定向校验、原生 FFmpeg HLS 去广告与短内容保护、评论缓存、本地资料缺失时在线回退及原有持久化数据。

代理证书策略逐请求生效：实际走代理的 HTTPS 请求允许错误证书；直连目标严格校验。Chromium 通过同一出口请求，重定向回到路由选择，直连下一跳不会继承证书放宽。经过系统根证书验证的公共中间证书继续提供给 Node 和 Chromium NSS，保留旧链兼容修复。

规则语义以固定官方版本为对照。已对齐的细节包括：POST 搜索同时保留查询参数与表单、XPath 属性选择器对应元素文本、过滤空线路后连续编号，以及同站协议和尾斜杠的剧集地址归一化。URL/私网限制、禁止 JSONPath 求值、脚本语法检查、规则字段类型、声明 API 不低于所用功能等级和资源上限属于 Web 运行边界；未实现的未来 API 版本会被拒绝。

## 兼容性验证

[测试目录](../test/compatibility) 保存两类固定输入：

1. 官方规则仓库提交 `ba8e10b35b0c3a56bbb6032a12356b0473844c64` 的完整 17 条规则，校验 JSON 与分享链接导入。
2. 17 组人工 HTML/API 样本，覆盖 XPath 作用域、`text()`/属性、空结果、空线路、POST、URL 归一化、五条真实 API 9 规则、JSON/form、opaque ID、模板编码、变量捕获、嵌套与分隔章节。

[golden.json](../test/compatibility/golden.json) 来自真实官方服务 `4effe14ee78b790a92c23ed86f969093d2ed376d` 的输出及实际发出的请求。请求比较包含方法、路径、解码后的查询参数和请求体；没有将不同运行时的默认 User-Agent 当作规则语义。

普通测试不访问公开片源，也不启动官方应用：

```bash
npm ci
npx playwright install chromium
npm run check
npm run test:e2e
```

浏览器回归另覆盖嵌套 iframe、无扩展名媒体、Cookie/UA 会话、验证码脚本、取消、代理证书分流及实际 MP4/HLS 播放。原生工具集成可以在构建出的镜像内执行：

```bash
docker run --rm --read-only --network none --tmpfs /tmp:mode=1777,exec \
  --mount type=bind,source="$PWD/test",target=/app/test,readonly \
  kazumi-web:local-engine node --test test/server/native-hls.test.js test/server/ech.test.js
```

### 与官方实现重新比较

[test/reference/kazumi-core](../test/reference/kazumi-core) 是开发参考，保留固定 Git SHA、锁文件、SDK 和原生验证。它被生产 Docker 上下文排除。重新构建需要访问 Flutter、Dart/原生依赖的下载服务；本次本机重建遇到 `ech_http` 原生资产下载 TLS 中断，因此使用已有、健康接口确认相同官方 SHA/API 的镜像完成对照，而非把下载失败算作兼容性通过。

```bash
docker build -t kazumi-core:engine-reference test/reference/kazumi-core
docker run -d --name kazumi-engine-reference \
  --publish 127.0.0.1:17331:7331 --add-host host.docker.internal:host-gateway \
  --shm-size 256m --env KAZUMI_EGRESS_PROXY=http://host.docker.internal:17332 \
  kazumi-core:engine-reference
KAZUMI_CORE_URL=http://127.0.0.1:17331 node scripts/check-kazumi-core.mjs
npm run compare:engines
docker rm -f kazumi-engine-reference
```

比较程序临时在 17332 启动允许测试私网的出口，在 17334 启动固定响应站点。它校验官方 SHA/API、全部规则导入，以及每组请求和输出。`--record` 仅在两边一致时更新 golden；参考版本或结果改变时必须显式审查、更新样本。Linux CI 的 host 网络配置见 [官方对照工作流](../.github/workflows/compatibility.yml)。

官方版本更新工作流只升级参考服务及参考 API 声明，不自动提高本地引擎的 API 等级。生产发布和普通 `Verify` 不依赖 Flutter；官方对照作为独立检查。

## 2026-10-20 性能结果

在同一 Docker Desktop Linux ARM64 虚拟机内，新建旧版 Node + Flutter 和新版 Node + Chromium 容器，共用本地 HTTP/视频 fixture；串行交替请求，每种操作预热两轮后采样 20 次。静态与动态解析均验证返回的视频字节，动态页面在 300 ms 后创建视频。没有同时运行测试或构建。详见 [原始结果及镜像标识](benchmarks/2026-10-20-runtime.json)。

| 项目                   | 旧版 Node + Flutter |       新版本地引擎 |
| ---------------------- | ------------------: | -----------------: |
| 镜像逻辑体积合计       |             1.95 GB |            1.40 GB |
| 首次请求前内存合计     |           204.7 MiB |          116.8 MiB |
| 本轮请求后内存合计     |           418.4 MiB |          324.1 MiB |
| 空闲 35 秒后内存合计   |           412.8 MiB |          157.6 MiB |
| 搜索中位数 / P95       |    17.30 / 18.47 ms |     7.25 / 8.59 ms |
| 章节中位数             |            16.50 ms |            5.82 ms |
| 静态 MP4 中位数        |            17.31 ms |            5.37 ms |
| 静态 HLS 中位数        |            19.08 ms |            5.77 ms |
| 动态 MP4 中位数 / P95  |  322.60 / 330.82 ms | 553.04 / 566.02 ms |
| 100 次混合请求累计 CPU |             3.48 秒 |            4.10 秒 |

这个样本中，镜像逻辑体积减少约 28%，浏览器回收后内存减少约 62%，搜索和静态解析明显更快。**动态解析仍慢约 71%，混合请求 CPU 时间高约 18%**；Chromium 启动、上下文创建、候选等待与媒体预检有成本。默认候选等待已从恢复代码的 700 ms 降至 150 ms，保留候选过滤与媒体验证。不能把这次迁移描述成所有路径都更快。

首次动态解析为旧版 323 ms、新版 658 ms；空闲回收后需要重新支付浏览器启动成本。镜像体积是各镜像逻辑大小之和，包含共享层，不是唯一磁盘块占用或下载流量。CPU 为 cgroup 累计使用时间差，内存是 Docker stats 快照，均不代表所有片源的峰值。公开站点网络、页面复杂度和硬件会改变结果。

单独的 [规则对照耗时](benchmarks/2026-10-20-compatibility.json) 是主机 Node 与 Docker Flutter 的混合环境，只用于核对运行情况；不将它作为同环境速度结论。

### 复现 Docker 对比

以下命令使用独立测试容器、端口和临时数据，不连接生产数据卷。先构建基线与当前镜像，再启动 [测试 Compose](../test/performance/compose.yaml)：

```bash
KAZUMI_BASELINE_DIR=$(mktemp -d)
git archive 0a560d76555633d20609744cc8d5feb368079c35 | tar -x -C "$KAZUMI_BASELINE_DIR"
docker build -t kazumi-web:engine-baseline "$KAZUMI_BASELINE_DIR"
docker build -t kazumi-core:engine-reference test/reference/kazumi-core
docker build -t kazumi-web:local-engine .
docker compose -f test/performance/compose.yaml up -d
E2E_FIXTURE_URL=http://fixture:4174 npm run benchmark:runtime -- \
  --rounds 20 --output /tmp/kazumi-runtime.json
docker compose -f test/performance/compose.yaml down
```

每次对比应重建测试容器以清空浏览器和 Cookie 状态，并让其他构建和测试结束后再测。程序核对参考版本，记录镜像 ID/架构/体积、冷请求、预热后的中位数/P95、CPU 和空闲回收内存；它不会创建发布标签或修改生产实例。
