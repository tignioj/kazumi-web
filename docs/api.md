# API 与持久化

[返回项目说明](../README.md)

- [番剧资料、评论与封面](#番剧资料评论与封面)
- [片源搜索、播放与下载](#片源搜索播放与下载)
- [规则、用户记录与管理接口](#规则用户记录与管理接口)
- [远程资料模式](#远程资料模式)
- [缓存刷新、网络设置与备份边界](#缓存刷新网络设置与备份边界)

以下是 Web 版自身的接口与数据流。默认 `METADATA_MODE=local`；切换到 `remote` 后，番剧资料的来源按下方「远程资料模式」变化。容量、更新间隔和代理方式以部署配置为准，文中列出代码默认值。

这里的「持久化」指数据写入部署服务器，重启后仍保留。**归档资料库**保存批量导入的动画及章节资料；**按需磁盘缓存**只保存已经获取的评论、图片或视频，可能刷新或被清理；**内存缓存或临时状态**不会跨服务重启保留。浏览器仍需连接 Web 服务器才能读取这些本地数据。

所有以 `/api/` 开头的地址都属于 Node 服务。表中的上游基址约定如下：

| 名称     | 默认地址                                                                             | 配置与用途                                                                 |
| -------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `BGM`    | `https://api.bgm.tv`                                                                 | `BANGUMI_API_URL`；远程资料模式的公开 API                                  |
| `NEXT`   | `https://next.bgm.tv`                                                                | `BANGUMI_NEXT_URL`；评论、封面地址查询，以及远程模式的热门榜、日历         |
| `RULES`  | `https://raw.githubusercontent.com/Predidit/KazumiRules/main/`                       | `RULES_REPOSITORY`；规则目录与规则 JSON                                    |
| 归档清单 | `https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json`           | `METADATA_ARCHIVE_MANIFEST_URL`；清单提供 ZIP 下载地址、版本、大小和校验值 |
| `CORE`   | Compose 内为 `http://kazumi-core:7331`，本地 Node 开发默认为 `http://127.0.0.1:7331` | `KAZUMI_CORE_URL`；内部规则执行及解析服务，不对外发布端口                  |

`BANGUMI_API_URL`、`BANGUMI_NEXT_URL`、`RULES_REPOSITORY` 和 `METADATA_ARCHIVE_MANIFEST_URL` 是 Node 进程环境变量；Compose 下需在服务的 `environment` 显式传入，仅写入 `.env` 不会自动覆盖这些上游地址，参见 [.env.example](../.env.example)。

下表中的 `DATA_DIR` 在本地 Node 模式下默认为项目根目录的 `data`，在 Compose 中固定为 `/app/data`，挂载到 `kazumi-data` 数据卷。它不等同于浏览器缓存，也不自动映射到宿主机的项目 `data` 目录。核心服务的初始化设置另存于 `kazumi-core-data` 卷，挂载在核心容器的 `/data`。

## 番剧资料、评论与封面

`{subjectId}` 为 Bangumi 番剧条目 ID，`{episodeId}` 为 Bangumi 章节 ID。章节 ID 与「第几集」不同，从 `GET /api/subjects/{subjectId}` 返回的 `episodes[].id` 取得。`page` 从 1 开始；两种评论都按每页 20 条顶层评论展示，回复随所属评论返回。

| 功能                                           | 本地接口                                             | 上游地址或数据来源                                                                                                                            | 缓存与更新策略                                                                     | 存储位置                                          |
| ---------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------- |
| 根据名称、别名搜索番剧资料                     | `GET /api/search?q=名称&page=1`                      | 本地官方归档 SQLite；查询时不访问 Bangumi                                                                                                     | 直接查询已导入资料，随归档更新                                                     | `DATA_DIR/metadata/metadata-{uuid}.sqlite`        |
| 番剧详情：名称、简介、评分、排名、标签、日期等 | `GET /api/subjects/{subjectId}`                      | 同上                                                                                                                                          | 评分、排名等是归档快照，随归档更新                                                 | 同上                                              |
| 正篇章节资料：集数、名称、日期、章节 ID 等     | 同一详情接口中的 `episodes`                          | 同上                                                                                                                                          | 直接查询本地章节；不包含片源播放 URL                                               | 同上                                              |
| 分类、标签、年份、季度筛选                     | `GET /api/categories`                                | 同上                                                                                                                                          | 根据请求条件查询本地资料                                                           | 同上                                              |
| 发现页热门榜、排名榜                           | `GET /api/catalog?sort=trending&page=1`；`sort=rank` | 本地归档中的日期、收藏数和排名                                                                                                                | 热门按近一年开播作品的累计收藏数排序；排名按归档排名排序                           | 原始资料在元数据库；榜单查询结果不另存文件        |
| 放送日历                                       | `GET /api/calendar`                                  | 本地章节播出日期；没有有效正篇章节日期时使用首播日期                                                                                          | 按北京时间生成当周日历；缺失日期不会推算为每周更新                                 | 原始资料在元数据库；日历结果不另存文件            |
| 番剧短评                                       | `GET /api/subjects/{subjectId}/comments?page=1`      | `GET NEXT/p1/subjects/{subjectId}/comments?limit=20&offset=…`                                                                                 | 按上游地址、番剧 ID 和分页按需持久缓存；有效期默认 30 分钟，失败回退旧缓存         | `DATA_DIR/comments/comments.sqlite`               |
| 每集评论及回复                                 | `GET /api/episodes/{episodeId}/comments?page=1`      | `GET NEXT/p1/episodes/{episodeId}/comments`                                                                                                   | 上游一次返回整集讨论及回复，本地持久缓存后分页；有效期默认 30 分钟，失败回退旧缓存 | 同上                                              |
| 封面图片                                       | `GET /api/image?url=…`                               | 直连或 ECH：必要时通过 `GET NEXT/p1/subjects/{subjectId}` 取得图片地址，再从 `https://lain.bgm.tv/…` 下载；镜像模式：`https://wsrv.nl/?url=…` | 访问后按需缓存图片和元信息；过期后台刷新，刷新失败可继续显示旧图；详细规则见下文   | `DATA_DIR/images/{sha256}.img` 及同名 `.img.json` |

本地资料未就绪或归档未收录的条目会返回错误，不会自动转到远程资料 API 补查。官方归档不含封面文件名和评论正文，因此导入资料库不会同时下载全部封面和评论。封面地址查询返回的完整 Next 条目响应不另存资料库，仅保存图片缓存所需的目标地址、有效期等元信息。

## 片源搜索、播放与下载

「搜索番剧资料」与「搜索可播放片源」是两个功能；Bangumi 提供作品资料，播放地址来自规则指定的网站。

| 功能                     | 本地接口                                                                                                                                                                | 上游地址或数据来源                                              | 缓存与更新策略                                                                                | 存储位置                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 搜索可播放片源           | `POST /api/rules/search`                                                                                                                                                | `POST CORE/search`，再按规则的 `searchURL` 请求各片源页面或 API | 搜索结果不持久化，仅用于当前搜索；没有统一的外部搜索 API                                      | 无独立结果文件；规则保存在 `DATA_DIR/rules.json`                       |
| 获取片源线路和播放列表   | `POST /api/rules/chapters`                                                                                                                                              | `POST CORE/chapters`，按规则请求片源详情页或 API                | 完整播放列表不持久化；观看记录和下载任务仅保存所需的来源、当前集等字段                        | 列表无独立文件；相关字段在 `watch-data.json` 和 `downloads/index.json` |
| 解析视频地址             | `POST /api/resolve`                                                                                                                                                     | 有已完成下载时返回本地文件；否则 `POST CORE/resolve` 解析片源   | 动态媒体地址与媒体会话属于临时状态，重启后需重新解析                                          | 会话仅在 Node 内存；已完成视频见下载目录                               |
| 普通在线播放与媒体代理   | `GET /api/media?…`                                                                                                                                                      | 解析得到的视频服务器、CDN、HLS 清单、分片或密钥地址             | 转发播放请求，不自动把视频保存到磁盘；iframe 播放由浏览器直接访问来源站点                     | 无整集持久文件                                                         |
| 原生 HLS 信息与过滤流    | `GET /api/native-media/info?…`；`GET /api/native-media/stream?…`                                                                                                        | 经同源媒体接口读取上游或已缓存 HLS                              | 信息探测结果内存缓存 5 分钟；过滤和转封装按请求运行，生成的在线播放流不落盘                   | 原生进程与请求状态临时；已有下载文件保留                               |
| 创建、查询和管理视频缓存 | `GET/POST/DELETE /api/downloads`；`POST/DELETE /api/downloads/batch`；`DELETE /api/downloads/{id}`；`POST /api/downloads/{id}/pause`；`POST /api/downloads/{id}/resume` | 下载或重试时请求片源和视频服务器；批量任务经核心解析            | 主动缓存后持久保存任务、已完成视频及可续传进度；默认容量 10 GiB，超额报错，不自动删除已有视频 | `DATA_DIR/downloads/index.json`、`DATA_DIR/downloads/{id}/`            |
| 播放或导出已完成缓存     | `GET /api/downloads/{id}/files/{name}`；`GET /api/downloads/{id}/download`                                                                                              | 本地已完成文件                                                  | 可跨重启播放，无需重新请求原站；HLS 导出时生成压缩包响应                                      | `DATA_DIR/downloads/{id}/`；导出响应不另留压缩包                       |

## 规则、用户记录与管理接口

| 功能                               | 本地接口                                                                                                   | 上游地址或数据来源                                              | 缓存与更新策略                                                                               | 存储位置                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 已安装规则的读取、导入、修改和删除 | `GET /api/rules`；`POST /api/rules/import`；`PUT/DELETE /api/rules/{name}`                                 | 用户输入或已安装规则；导入和修改通过 `POST CORE/validate` 校验  | 成功修改后持久保存                                                                           | `DATA_DIR/rules.json`                                                                |
| 单独校验规则                       | `POST /api/rules/validate`                                                                                 | `POST CORE/validate`                                            | 只校验，不保存规则                                                                           | 无                                                                                   |
| 官方规则目录及更新检查             | `GET /api/rules/catalog`；`GET /api/rules/updates`                                                         | `GET RULES/index.json`；需要时读取 `GET RULES/{规则名}.json`    | 目录及规则详情可在内存缓存 1 小时；更新检查结果不持久化，不修改已安装规则                    | 仅内存，无独立磁盘缓存                                                               |
| 安装、更新官方规则                 | `POST /api/rules/install`；`POST /api/rules/update`                                                        | `GET RULES/index.json` 和 `GET RULES/{规则名}.json`，经核心校验 | 安装或更新时刷新所需上游数据；校验成功后保存已安装规则，失败保留原规则                       | `DATA_DIR/rules.json`                                                                |
| 收藏、历史、播放进度               | `GET /api/watch-data`；`PUT/DELETE /api/watch-data/library/{id}`；`PUT/DELETE /api/watch-data/history`     | 本地服务器管理，无外部上游                                      | 修改后持久保存；历史保留最近 200 条，所有设备共享                                            | `DATA_DIR/watch-data.json`                                                           |
| 恢复记录与迁移浏览器旧数据         | `PUT /api/watch-data`；`POST /api/watch-data/migrate`                                                      | 备份或旧浏览器数据，无外部上游                                  | 恢复覆盖服务器记录；迁移按现有合并规则保存                                                   | 同上                                                                                 |
| 读取、保存网络配置                 | `GET/PUT /api/network-settings`                                                                            | 本地配置，无外部上游                                            | 保存后跨重启生效                                                                             | `DATA_DIR/network-settings.json`                                                     |
| 测试连接                           | `POST /api/network-settings/test`                                                                          | 请求体中所选目标 URL，按类型应用代理、ECH 或图片镜像设置        | 仅返回本次测试结果，不保存配置或测试结果                                                     | 无                                                                                   |
| 预览分流                           | `POST /api/network-settings/preview`                                                                       | 当前表单设置及目标 URL，无外部请求                              | 返回实际目标、命中的规则和出口，不保存配置                                                   | 无                                                                                   |
| 读取、保存下载线程设置             | `GET/PUT /api/download-settings`                                                                           | 本地配置，无外部上游                                            | 保存后跨重启生效                                                                             | `DATA_DIR/downloads/settings.json`                                                   |
| 归档状态与更新                     | `GET /api/metadata/status`；`POST /api/metadata/update`                                                    | `GET` 归档清单，再请求清单中的 ZIP 地址                         | 默认首次启动导入、每 24 小时检查；成功后原子切换数据库，失败保留旧资料；仅本地资料模式可更新 | `DATA_DIR/metadata/` 下的 SQLite、`current.json`、`status.json`；下载 ZIP 为临时文件 |
| 验证码会话、状态、操作与取消       | `GET /api/verification-session`；`GET/DELETE /api/verification/{id}`；`POST /api/verification/{id}/action` | 核心的 `/captcha/*` 接口及对应片源验证页面                      | Web 验证任务仅在内存中，默认 5 分钟过期；完成结果可供短时轮询，取消、过期或重启后释放        | Node 内存及浏览器会话 Cookie，无 Web 任务持久文件                                    |
| 健康检查                           | `GET /api/health`                                                                                          | 无外部上游                                                      | 即时返回状态，不缓存                                                                         | 无                                                                                   |

## 远程资料模式

设置 `METADATA_MODE=remote` 后，上面关于本地元数据库的查询改为下表来源；Web 接口路径保持不变。远程资料查询结果仅有 **5 分钟内存缓存**，不会写入本地元数据库，重启后丢失。评论和封面的磁盘缓存仍按各自规则工作。

| 功能与本地接口                                                                  | 远程上游                                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 名称搜索 `/api/search`、分类 `/api/categories`、排名榜 `/api/catalog?sort=rank` | `POST BGM/v0/search/subjects?limit=24&offset=…`                                                  |
| 番剧详情 `/api/subjects/{subjectId}`                                            | `GET BGM/v0/subjects/{subjectId}`                                                                |
| 同一详情响应中的正篇章节                                                        | `GET BGM/v0/episodes?subject_id={subjectId}&type=0&limit=200&offset=0`；当前远程实现只读取这一页 |
| 热门榜 `/api/catalog?sort=trending`                                             | `GET NEXT/p1/trending/subjects?type=2&limit=24&offset=…`                                         |
| 日历 `/api/calendar`                                                            | `GET NEXT/p1/calendar`；请求失败时尝试 `GET BGM/calendar`                                        |

## 缓存刷新、网络设置与备份边界

- **评论**：默认 30 分钟有效；请求加 `refresh=1` 可主动刷新。成功获取后写入 SQLite；过期或主动刷新失败时返回已有缓存，未缓存时返回错误。响应中的 `cache.cached`、`cache.stale`、`cache.updatedAt` 表示是否复用缓存、是否因获取失败回退及上次成功获取时间（Unix 毫秒）；新获取响应的 `cache.persisted=false` 表示本次未能落盘。缓存内容默认最多 50 MiB 或 2000 个条目，淘汰最早更新的内容，不等同于永久保存全部评论。
- **封面**：遵循上游 `Cache-Control`，缺省有效期 7 天；上游要求 `no-store` 时不落盘。已有图片可先显示，过期后后台重新验证或更新；`refresh=1` 会等待正在进行的刷新，失败仍可返回已有图片。默认上限为 5 GiB、5000 张图片，按最近使用情况淘汰，并清理 30 天未使用的图片；`IMAGE_CACHE_MAX_BYTES=0` 关闭磁盘缓存。首次加载及缓存被淘汰后仍需访问上游。
- **资料库**：归档检查与浏览查询分开。已导入的数据可在外网不可用时查询；评分、排名、日期等随归档更新，不是每次查询都获取实时值。归档更新失败继续使用原数据库。
- **视频**：只有主动缓存的文件及续传进度落盘，普通播放、解析出的地址、媒体会话和原生过滤流不会因此变成持久缓存。已下载文件仍受手动删除和数据卷生命周期影响。
- **网络类别**：评论和远程资料查询使用「Bangumi API 请求代理」及 API ECH 开关；封面下载和封面地址查询使用「番剧图片请求代理」及封面方式；规则目录、安装和更新使用「规则仓库请求代理」；归档检查和下载使用「资料归档下载代理」；片源搜索、解析、播放和视频下载使用「视频源请求代理」。已缓存内容可能仍发起刷新，详见各自策略。
- **分流配置**：`proxies` 保存最多 16 个额外出口（`id/name/url/username/password`）；原有顶层地址和认证字段表示 `default` 出口。`scopeProxies` 将 `video/image/bangumi/rules/archive` 映射到默认出口 ID。`routingRules` 最多 200 条，字段为 `id/name/enabled/scope/matchType/value/action/proxyId`，其中 `scope` 可为 `all`，`matchType` 为 `domain/domainSuffix/domainKeyword/cidr/all`，`action` 为 `proxy/direct`。首条匹配覆盖类型默认开关；重定向按新的目标主机重新匹配，IP 网段仅匹配 IP 目标。保存引用不存在的代理会返回 400，已有配置保持原样。
- **代理密码与测试**：读取设置仅返回各出口的 `hasPassword`，不返回密码；更新代理时按 ID 保留未提交的密码，显式 `password: ""` 清除。预览及测试请求体为 `{settings, scope, url}`，省略的设置项沿用已保存值。两者返回的 `routing` 包含 `scope/hostname/action/proxyId/proxyName/ruleId/ruleName`，不含代理凭据；连接失败也返回命中的出口信息。应用直连不绕过系统或路由器 TUN。
- **备份**：完整备份应停机后保存 `kazumi-data` 和 `kazumi-core-data` 数据卷；本地 Node 模式保存 `DATA_DIR` 和核心服务的数据目录。网页导出的 JSON 备份包含收藏、历史及界面偏好，不包含番剧资料库、评论、封面、视频、已安装规则或服务器网络配置。界面主题等浏览器偏好使用 `localStorage`，不属于服务器 API 持久化。
