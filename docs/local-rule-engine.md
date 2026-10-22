# 本地规则引擎、兼容性与性能

生产服务在 Node 内执行 XPath / API 9 规则，并优先静态提取视频。需要执行页面脚本或验证码时，才启动 Chromium。Compose 和发布流程只有 `kazumi-web`；不下载或启动官方 Flutter 应用。

本次迁移以 `0a560d76555633d20609744cc8d5feb368079c35` 为基线，按模块恢复 `1a3f695` 之前的实现，保留之后的业务与网络修复，没有整次回退提交。

## 实现边界

- [规则引擎](../server/modules/rules/engine.js)：XPath、受限 JSONPath、GET/POST、JSON/form、API 9 来源模板、嵌套和分隔文本章节、剧集 URL 归一化。
- [视频解析](../server/modules/playback/source-resolver.js)：直链、媒体元素、MacCMS 元数据、有限层数的 iframe；保留已有 HHJX 和 7sefun 适配。
- [浏览器](../server/modules/playback/browser-resolver.js)：通用嗅探、规则验证码、访问者 Cookie/UA 隔离、媒体预检、最多两个并发任务；排队最多 30 秒，支持取消。空闲 30 秒后关闭浏览器，已验证的 Cookie 会话仍留在 Node 内存。
- [媒体传输](../server/modules/playback/media.js)：沿用服务端媒体会话、Range、无扩展名格式识别、HLS 同源重写和下载接口。客户端签名链接不包含来源凭据。

规则执行、页面解析和浏览器解析使用 `videoHttp`，保留正常的 HTTP 协议协商。媒体代理和下载使用独立的 `mediaHttp`，沿用同一套视频代理及分流设置，限定 HTTP/1.1，避免 HTTP/2 在暂停读取时误触发响应体超时。这项设置不会把规则请求一起降级。

普通视频的 Range 在代理内部按 512 KiB 分块并有限预取，慢连接从已收到的位置续传，使用 `ETag` / `If-Range` 校验文件版本；浏览器仍收到原请求范围的连续响应。拖动或关闭播放会取消旧请求。网页播放器另保留 15 秒无进展时的恢复兜底，恢复位置、倍速和播放／暂停状态。

暂停后浏览器可能重新验证过期的视频缓存。媒体代理转发本次请求的 `If-None-Match` / `If-Modified-Since`，依据响应头返回 304，无需等待分片下载；源站对条件请求返回 416 时，去除缓存条件重新获取响应头并校验版本，文件变更时仍返回实际数据，真实的越界范围仍返回 416。解析阶段捕获的 Range 和缓存条件不会复用到后续播放请求。

保留四源并发及流式搜索、超时后的已完成结果、单来源重试、断连重试一次和分类错误；保留现有分流、代理出口、ECH、DNS/重定向校验、原生 FFmpeg HLS 去广告与短内容保护、评论缓存、本地资料缺失时在线回退及原有持久化数据。

代理证书策略逐请求生效：实际走代理的 HTTPS 请求允许错误证书；直连目标严格校验。Chromium 通过同一出口请求，重定向回到路由选择，直连下一跳不会继承证书放宽。经过系统根证书验证的公共中间证书继续提供给 Node 和 Chromium NSS，保留旧链兼容修复。

规则语义以固定官方版本为对照。已对齐的细节包括：POST 搜索同时保留查询参数与表单、XPath 属性和 `text()` 选择器对应完整元素文本、过滤空线路后连续编号，以及同站协议、尾斜杠和百分号编码的剧集地址归一化。剧集地址解码未保留字符并统一其他转义的大小写，媒体地址仍保留原始签名编码。

API query/form 沿用官方 Dio 默认的多值编码：标量数组使用重复键，嵌套对象使用方括号路径，数组中的集合使用下标，null 使用无等号的键，空集合不发送。API query 追加到 URL 原有查询参数之后；XPath POST 保留原查询参数，但表单中的重复键按官方行为取最后一个值。启用反爬配置的 XPath 搜索收到非成功响应且包含 `cf-mitigated: challenge` 时，即使正文为空也进入验证；Chromium 中再次收到该响应头也支持自动或人工验证。

URL/私网限制、禁止 JSONPath 求值、脚本语法检查、规则字段类型、声明 API 不低于所用功能等级和资源上限属于 Web 运行边界；未实现的未来 API 版本会被拒绝。

## 兼容性验证

兼容性验证使用两类固定输入：

1. [内置官方规则快照](../server/defaults/official-rules.json) 保存官方规则仓库提交 `ba8e10b35b0c3a56bbb6032a12356b0473844c64` 的完整 17 条规则，同时供离线目录和 JSON/分享链接导入测试使用。
2. 26 组人工 HTML/API 样本，覆盖 XPath 作用域、混合 HTML 的 `text()`/属性、空结果、空线路、POST 重复参数、URL 编码归一化、仅响应头的 Cloudflare 挑战、全部八条官方 API 规则、JSON/form、集合参数、opaque ID、模板编码、变量捕获、嵌套与分隔章节。官方 API 场景直接读取上述快照，更新选择器和模板会进入执行测试；遇到尚无响应样本的新 API 规则会明确失败，要求补充样本。

[golden.json](../test/compatibility/golden.json) 来自真实官方服务 `4effe14ee78b790a92c23ed86f969093d2ed376d` 的输出及实际发出的请求。请求比较包含方法、路径、解码后的查询参数和请求体。查询参数及 form 请求体保存为有序键值对，保留重复键、空值和顺序，避免转为普通对象后隐藏差异；JSON 请求体保留原有类型。验证错误分别检查官方与本地错误码，再比较是否需要验证。没有将不同运行时的默认 User-Agent 当作规则语义。

普通测试不访问公开片源，也不启动官方应用：

```bash
npm ci
npx playwright install chromium
npm run check
npm run test:compat:browser
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
npm run compare:browser-engines -- --output test-results/browser-comparison.json
docker rm -f kazumi-engine-reference
```

比较程序临时在 17332 启动允许测试私网的出口，在 17334 启动固定响应站点。它校验官方 SHA/API、全部规则导入，以及每组请求和输出。`--record` 仅在两边一致时更新 golden；参考版本或结果改变时必须显式审查、更新样本。Linux CI 的 host 网络配置见 [官方对照工作流](../.github/workflows/compatibility.yml)。

官方版本更新工作流只升级参考服务及参考 API 声明，不自动提高本地引擎的 API 等级。生产发布和普通 `Verify` 不依赖 Flutter；官方对照作为独立检查。

### 主分支、规则快照与审查

每日工作流同时检查稳定版、`Predidit/Kazumi` 的 `main` 和 `Predidit/KazumiRules` 默认分支。稳定版与 main 共用 `scripts/lib/kazumi-relevance.mjs` 的正向策略：比较两次完整 Git 树，识别规则引擎、请求/网络、视频地址解析、验证码及共用工具的新增、修改和删除；树被截断或历史分叉时检查失败，留待人工处理。原生播放器控件、主题、图标、音量等 UI 不在监控范围，`lib/utils` 也只监控共用的 URL、请求头、编码、并发和媒体工具。混合了 UI 样式与请求头的 `constants.dart` 只比较 UA、Accept-Language 及 Bangumi 请求头声明，忽略其滑块等原生样式变化。

`pubspec.yaml` / `pubspec.lock` 变化本身不触发 PR。逐包比较运行时约束、`dependency_overrides` 与锁定来源、版本、哈希和 Git revision，仅保留策略列出的 HTML/XPath/JSON 解析、HTTP/Cookie/加密/ECH、视频/验证码 WebView 及共用基础依赖；已列入策略的传递依赖只有锁文件变化也会触发。忽略纯 UI/平台/开发工具依赖，以及单独的应用版本、Dart/Flutter SDK 声明、格式或依赖 direct/transitive 标签变化。有相关行为变化时仍按新版 SDK 要求固定工具链。遇到未支持的依赖 YAML 结构会失败，避免悄悄漏报。

依赖清单与共用工具路径是显式维护的策略，不推断整个 Dart 包的传递依赖图。上游引入新的解析/网络/浏览器库或调整目录时，维护者应在相关源码 PR 中补充策略及回归样本；未列入策略的包不会单独触发 PR，名称和被忽略的路径会保留在工作流摘要供核查。PR #5 对应的进度条重构和 `audio_video_progress_bar` 删除应得到 `available: false`，参考提交保持不变；后续相关更新会从原参考累计比较，不会因为跳过 UI 提交而遗漏其中的相关代码。

核心 PR 描述包含固定提交前后值、上游提交摘要、相关文件增删改、可用的 diff 摘录，以及依赖约束/版本/来源/SHA 的逐字段差异；按规则、网络、视频解析、验证码列出待核查行为，不把推测的影响写成已验证改善。只更新测试参考不会自动修复线上 Node 引擎。规则快照从同一不可变提交读取索引和所有规则，校验名称、版本、重名和完整下载；忽略仅文档或目录排序变化。下载失败保留原快照。规则 PR 列出名称、版本和具体字段前后值；快照升级不会修改用户已安装的规则。

机器人为每种更新来源保留一个待审查 PR，等待审查期间仍只读检查后续变化并写入工作流摘要，保留维护者修改；已关闭的相同提交不再提出。通过 `workflow_dispatch` 显式触发完整 Verify 和官方对照，避免机器人 push 不触发检查。PR 要求审查上游代码与规则差异，为新语义补充 HTML/API 或浏览器场景；现有 XPath 规则全部验证 JSON/分享链接导入，只有已有固定响应样本的规则执行离线站点解析，不把导入成功当作真实站点可用。

更改参考提交或规则快照后，golden 元数据也会变化，首次官方对照因此可能失败。先处理实际行为差异，再对已经启动的新参考执行 `npm run compare:engines -- --record`，审查并提交 golden，重新运行两项检查。机器人不录制 golden、不提高本地 API 等级，也不合并 PR。仓库分支保护应要求维护者审查和两项检查通过。

### 动态播放和验证码对照

`compare:browser-engines` 使用本地固定页面，启动真实 Chromium，并与上述官方参考的 Linux WebKit 执行相同的十组场景：延迟 MP4、嵌套 iframe HLS、无扩展名视频、图片验证码、POST 搜索验证码、自动点击、自定义验证脚本、Cloudflare 响应头挑战、取消验证、取消视频解析后恢复。验证媒体 URL、类型、签名编码和实际 MP4/HLS 字节；验证错误答案不获授权、原 POST 参数重放、Cookie 与浏览器 UA 复用、访问者隔离和会话清理。结果写入 CI artifact；任一引擎失败或结果不同都会失败，缺少 Chromium 不会跳过。

官方 XPath 章节请求明确不附验证 Cookie；Web 已有的章节 Cookie 复用属于额外能力，在本地路径单独断言，不削弱它以迎合官方限制。公共站点、真实 Cloudflare 服务和人工验证码供应商不参与固定场景，仍需对受影响来源进行人工抽查。普通 `Verify` 运行同一套本地浏览器场景；官方工作流运行双引擎对照，播放、验证码、网络和测试脚本修改均会触发。

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
