# Kazumi Web

将 [Kazumi](https://github.com/Predidit/Kazumi) 的番剧浏览和基于规则的观看流程迁移到浏览器，使用 React + Node.js，支持 Docker Compose 一键部署。此目录是独立 Web 工程，不需要 Flutter SDK，也不会修改旁边的原版工程。

## 部署

需要 Docker Engine 和 Docker Compose v2 或更高版本。在本目录运行：

```bash
docker compose up -d --build
```

打开 <http://localhost:3000>。其他设备使用 `http://服务器IP:3000`。首次构建需要访问 npm 和 Docker 镜像仓库。

修改监听地址和端口：

```bash
cp .env.example .env
# 编辑 .env，例如 PORT=8080
docker compose up -d
```

常用维护命令：

```bash
docker compose ps
docker compose logs -f --tail=100 kazumi
docker compose up -d --build          # 更新代码后重新构建
docker compose down                  # 停止服务，保留规则数据
```

容器以非 root 用户运行，根文件系统只读，带健康检查。`kazumi-data` 数据卷保存规则；重新创建容器不会丢失规则。`docker compose down -v` 会删除规则数据卷，请勿将其用作普通停止命令。

## 使用

1. 在「发现」浏览番剧，或搜索番剧名称；「放送时间表」查看每周放送。
2. 打开详情，选择收藏状态，或搜索播放源。也可以直接按名称搜索规则源，不依赖 Bangumi 条目。
3. 选择结果、播放线路和剧集。可解析的 MP4/HLS 使用内置播放器；仅提供网页的源使用网页播放器或打开原站。
4. 在规则管理中导入原版 Kazumi JSON、规则数组或 `kazumi://` 分享文本，也可从官方规则仓库安装。规则支持编辑、导出和删除。
5. 追番状态、播放进度、历史记录和界面设置保存在当前浏览器，可在设置中导出备份后导入到其他浏览器。

## 迁移范围

| 功能                                      | Web 版                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| Bangumi 目录、搜索、详情、时间表          | 支持，由服务端请求元数据                                                       |
| XPath 规则                                | 支持搜索、POST 搜索、多线路和分集                                              |
| API 规则                                  | 支持 GET/POST、JSON/form 请求、JSONPath、嵌套/分隔字符串剧集、请求和播放页模板 |
| 规则管理                                  | 导入、导出、编辑、删除、官方仓库安装；服务端持久化                             |
| 视频播放                                  | MP4/浏览器可解码视频、HLS、倍速、全屏、进度恢复、分集切换                      |
| 收藏与历史                                | 浏览器本地保存，JSON 备份与恢复                                                |
| 适配                                      | 桌面和移动端布局、明暗主题                                                     |
| 原生播放器/WebView 嗅探                   | 以静态媒体解析和网页播放代替；不能保证所有原版源可用                           |
| 弹幕、Bangumi 账号/WebDAV 同步、一起看    | 当前未移植                                                                     |
| DLNA、Anime4K、离线后台下载、系统媒体控制 | 当前未移植                                                                     |

这是独立的 Web 移植实现。原版依赖原生 WebView、验证码交互、JavaScript 动态解密或特殊视频解码器的源，可能无法在内置播放器中使用。源站的 iframe 限制、浏览器自动播放策略、HTTPS 页面对 HTTP 媒体的限制仍适用。播放失败时可换源，或使用页面提供的原站链接。

API 规则的 JSONPath 支持字段访问、数组索引与通配符，不执行过滤脚本或递归下降。验证码可用文本/XPath 检测并提示，服务端不执行规则中的任意 JavaScript 或正则验证码检测，也不提供原生 WebView 的交互式验证。

## 数据和网络

- 服务端保存规则，访问同一部署的用户共享这套规则。追番和历史按浏览器保存，不是账户同步。
- 番剧资料来自 Bangumi；规则来自用户导入或上游 KazumiRules。第三方服务不可达时界面会显示错误，页面没有伪造的番剧或播放数据。
- 服务端代理站点请求及媒体资源，处理跨域和防盗链请求头。HLS 的子清单、分片和密钥地址会重写为同源代理地址。
- 默认拒绝代理访问本机、私网、链路本地和云元数据地址，并校验重定向目标。
- 默认适用于个人/家庭局域网部署，没有多用户登录和权限隔离。若要公开部署，请在前置反向代理配置 HTTPS 和访问认证，避免陌生人修改共享规则或消耗代理流量。

浏览器备份不包含服务端规则，迁移时应同时导出规则。备份包含观看记录，请自行妥善保存。

## 本地开发

需要 Node.js 24+：

```bash
npm ci
npm run dev
```

前端：<http://localhost:5173>；后端：<http://localhost:3000>。Vite 将 `/api` 转发至后端。

如果开发机的 3000 端口已被占用，设置 `API_PORT=3100` 后执行 `npm run dev`，前后端代理会一起使用新端口。开发模式不自动读取部署用的 `.env`；需要 DoH 时请将 `DNS_OVER_HTTPS_URL` 设置为进程环境变量。

```bash
npm test             # 规则解析、媒体代理和服务端测试
npm run build        # 构建 dist
npm start            # 同一个 Node 服务提供 API 和构建后的网页
npm run smoke        # 检查运行中的生产实例（BASE_URL 可指定地址）
```

浏览器回归测试：

```bash
npx playwright install --with-deps chromium
npm run test:e2e
```

### 服务端环境变量

| 变量                    | 默认值                | 用途                                                                                                                |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `HOST`                  | `0.0.0.0`             | Node 监听地址                                                                                                       |
| `PORT`                  | `3000`                | Node 监听端口；Compose 中 `.env` 的 PORT 只修改宿主机映射                                                           |
| `DATA_DIR`              | `./data`              | 规则数据目录，容器为 `/app/data`                                                                                    |
| `BANGUMI_API_URL`       | `https://api.bgm.tv`  | Bangumi API 基址                                                                                                    |
| `BANGUMI_NEXT_URL`      | `https://next.bgm.tv` | Bangumi Next API 基址                                                                                               |
| `RULES_REPOSITORY`      | 上游 KazumiRules 仓库 | 规则目录和规则文件基址                                                                                              |
| `ALLOW_PRIVATE_NETWORK` | `false`               | 仅可信内网源/隔离测试环境可开启；Compose 默认关闭                                                                   |
| `DNS_OVER_HTTPS_URL`    | 空                    | 可选的 DNS JSON 查询端点，例如 `https://1.1.1.1/dns-query`；仍校验并绑定解析后的公网 IP，Compose 支持从 `.env` 传入 |

高级环境变量需要添加到 `compose.yaml` 的 `environment`，仅写入 `.env` 不会自动传入容器。

若开启了 TUN/Fake-IP DNS，域名可能解析为 `198.18.x.x`，页面会提示「域名解析到私有或保留网络地址」。在 `.env` 设置 `DNS_OVER_HTTPS_URL=https://1.1.1.1/dns-query` 后重新运行 `docker compose up -d`，不必关闭内网访问保护。DNS 查询将由所配置的解析服务处理。

## 常见问题

**网页能打开，番剧或规则列表加载失败？** 检查服务端到 Bangumi/GitHub/源站的网络连通性，查看容器日志，并在页面重试。浏览器可以联网不代表 Docker 容器可以访问同一服务。

**能看到剧集，但视频不能播放？** 源站可能使用动态解析、验证码、iframe 防嵌入或浏览器不支持的编码。尝试其他源或原站链接。网页模式下无法读取第三方播放器的时间进度。

**换设备后没有追番和历史？** 它们保存在浏览器 localStorage；在原设备导出备份，再在新设备导入。浏览器清理站点数据也会移除这些记录。

**规则数据丢失？** 确认使用同一 Compose 项目名及其数据卷。不要执行 `down -v`。可从先前导出的规则恢复。

## 来源与许可

以 Kazumi `35ae2f62e76f33d85873ef1ddfcf2babe07e1138` 的规则格式及业务流程为迁移依据，保留 [GPL-3.0 许可证](LICENSE)。原版：[Predidit/Kazumi](https://github.com/Predidit/Kazumi)；规则：[Predidit/KazumiRules](https://github.com/Predidit/KazumiRules)；元数据：[Bangumi](https://bangumi.tv/)；HLS 播放：[hls.js](https://github.com/video-dev/hls.js)。

本工程使用自行绘制的文字标识，没有复制原版受单独授权限制的图标和字体。请只导入和访问你有权使用的内容。
