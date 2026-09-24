# 项目规范

- `package-lock.json` 只能由 npm 生成和更新；不得使用编辑工具或脚本直接修改，包括新增 workspace 的链接和元数据。
- packages 采用 `index.ts` 入口 + `src/*.ts` 的结构
