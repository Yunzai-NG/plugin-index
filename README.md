# plugin-index

[Yunzai NG](https://github.com/Yunzai-NG/yunzai-ng) 的官方插件索引。本仓库有**两份**，
消费者、字段与顶层键都不同：

| 文件 | 谁读它 | 顶层键 | 版本门 | 装到哪 |
|---|---|---|---|---|
| `index.json` | 内核的**插件市场**页 | `plugins` | `minCore` | 内核的插件目录 |
| `webui_index.json` | 面板的**面板商店**页 | `panels` | `minWebui` | webui 安装目录下的 `plugins/` |

前者是适配器、渲染器与功能插件；后者是往面板上添组件的面板插件包。

**两份刻意互不相认。** 顶层键不同，故把面板索引填进 `market.sources` 会直接报「格式不符」，
而不是列出一堆装到错地方的条目；反向同理。

默认索引地址即本仓库：

```
https://raw.githubusercontent.com/Yunzai-NG/plugin-index/main/index.json
https://raw.githubusercontent.com/Yunzai-NG/plugin-index/main/webui_index.json
```

前者可在 `config/yunzai.yaml` 的 `market.sources` 中替换或追加，后者在面板自己的配置项
`store.sources` 里。镜像前缀 `market.mirror` **两处共用**，只填一遍。

## 提交插件

欢迎提交 PR 将自己的插件加入索引。在 `index.json` 的 `plugins` 数组中追加一条记录：

```json
{
  "name": "你的插件名",
  "title": "展示名称",
  "description": "一句话说明。",
  "author": "你的名字",
  "version": "1.0.0",
  "homepage": "https://github.com/你/你的插件",
  "minCore": "0.1.0",
  "tags": ["功能"],
  "install": {
    "type": "git",
    "url": "https://github.com/你/你的插件",
    "branch": "main"
  }
}
```

提交前请在本地执行校验：

```powershell
pnpm run validate
```

要求：

- `name` 与 `install` 为必填。`name` 须匹配 `/^[a-z\d][a-z\d._-]*$/i` 且不以点开头 ——
  该名称会成为插件的安装目录名。
- `install.url` 须以 `http://` 或 `https://` 开头，`install.type` 为 `git` 或 `tarball`。
- 仓库须**公开可读**：本机无 git 的使用者走归档下载路径，私有仓库将导致其无法安装。
- 仓库根须有 `package.json`，或 `index.js`、`index.mjs`、`index.cjs`、`dist/index.js`、
  `dist/index.mjs` 之一 —— 内核以此判定取到的内容具备插件形态。
- `official` 仅由本组织维护的插件使用。

字段完整说明见[插件市场文档](https://github.com/Yunzai-NG/yunzai-ng/blob/main/docs/market.md)。

## 提交面板插件

改 `webui_index.json` 的 `panels` 数组：

```json
{
  "name": "你的包名",
  "title": "展示名称",
  "description": "一句话说明。",
  "author": "你的名字",
  "version": "1.0.0",
  "homepage": "https://github.com/你/你的包",
  "minWebui": "0.1.0",
  "tags": ["监控"],
  "widgets": 3,
  "server": true,
  "deps": true,
  "install": {
    "type": "git",
    "url": "https://github.com/你/你的包",
    "branch": "main"
  }
}
```

与上面那份的差别：

- **版本门是 `minWebui` 而非 `minCore`。** 面板插件用的是面板给的注入口，那随面板版本走。
  写成 `minCore` 不会被读取，校验脚本报错。
- **只收「包」形态**：仓库根须有 `index.js` 与 `package.json`。单文件的 `.js` 上不了商店 ——
  它的版本号 node 侧读不到，无从判断该不该更新。
- **一个仓库一个包，`install` 没有 `path` 字段。** 装子目录就无从就地拉取更新（`.git` 在仓库
  根）。要放多枚组件时让那个包导出多枚。
- `widgets` / `server` / `deps` 三项是**预告**，仅供商店列表展示；装完一律以包的
  `package.json` 为准。故 `widgets` 填错数目不会让 CI 红，只查类型。

字段完整说明见[面板插件文档](https://github.com/Yunzai-NG/yunzai-ng/blob/main/docs/panel-plugin.md)。

## 校验规则

`scripts/validate.mjs` 的判定规则与内核的 `parseIndex` 逐条一致，并把内核的"静默丢弃"
升格为错误。**内核对不合法记录不报错**，仅将其从列表中剔除；因此一处拼写错误的表现是
插件不出现在面板中，而非任何提示。该脚本的存在即为暴露这一类问题。

另有两项内核不做的检查：名称重复（内核按先出现者为准，靠后者永不被安装）与 `official`
非布尔值（写成字符串 `"true"` 会使官方插件显示为社区插件）。

## 许可

AGPL-3.0-or-later
