# 项目规范

- packages 采用 `index.ts` 入口 + `src/*.ts` 的结构
- 仓库只保留根目录 `package.json`
- 使用 pnpm 管理依赖，依赖与脚本集中在根目录
- `pnpm-lock.yaml` 只能由 pnpm 生成和更新
