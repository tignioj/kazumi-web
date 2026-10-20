# 发布 Docker Hub 镜像

[`Publish Docker images`](../.github/workflows/docker-publish.yml) 在推送 `v` 开头的版本标签时运行，先执行现有 `Verify`（包含回归、官方输出样本和浏览器联调），再分别在原生 AMD64、ARM64 runner 构建 `kazumi-web` 镜像。全部构建成功后，合并并发布 `linux/amd64`、`linux/arm64` 镜像。

仓库的 **Settings → Secrets and variables → Actions** 需要配置：

- **Variables**：`DOCKERHUB_USERNAME=tignioj`（未设置时使用 GitHub 仓库所有者）。
- **Secrets**：`DOCKERHUB_TOKEN`，使用具有 Docker Hub 读写权限的 [Personal Access Token](https://docs.docker.com/security/access-tokens/)，不使用账号密码。

正式版本从默认分支 `main` 发布，使用本地规则引擎。原官方核心实现保留在 `codex/upstream-core`，不作为后续正式发布来源。

先切换到 `main` 并同步，确认待发布提交已通过验证，再递增 `package.json` / `package-lock.json` 的版本、提交并推送。给该提交打标签并创建 GitHub Release：

```bash
git switch main
git pull --ff-only origin main
# 后续发布时，将 1.0.4 替换为下一个尚未使用的版本。
npm version 1.0.4 --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore(release): prepare v1.0.4"
git push origin main
git tag -a v1.0.4 -m "Release v1.0.4"
git push origin v1.0.4
gh release create v1.0.4 --verify-tag --target main --title v1.0.4 --generate-notes
```

例如 `v1.0.4` 会为 `tignioj/kazumi-web` 发布 `v1.0.4`、`1.0.4`、`sha-<提交号前7位>` 和 `latest` 标签。`v1.1.0-rc.1` 等预发布版本只发布对应版本和提交标签，不更新 `latest`。普通分支 push 和 PR 只运行验证；在 Actions 页面手动对分支运行 `Publish Docker images`，会验证并构建两种架构，但不会上传镜像。GitHub Release 创建后仍需确认 `Publish Docker images` 成功，才能使用新镜像。

使用已发布镜像时，将 `compose.yaml` 中的 `image` 改为 `tignioj/kazumi-web:1.0.4`，然后执行：

```bash
docker compose pull
docker compose up -d --no-build --remove-orphans
```

升级时修改镜像版本，重复以上命令；数据卷会保留。
