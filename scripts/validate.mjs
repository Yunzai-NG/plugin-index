#!/usr/bin/env node
/**
 * 索引校验 —— 把"消费者会静默丢弃这条记录"变成 CI 会红的断言
 *
 * 本仓库有**两份索引**，消费者不同、字段不同、顶层键不同：
 *
 *   index.json        内核的插件市场。顶层 `plugins`，版本门是 `minCore`
 *   webui_index.json  面板插件商店（由 webui 自己开）。顶层 `panels`，版本门是 `minWebui`
 *
 * 为什么需要本脚本：两个消费者对不合法记录都**静默丢弃**，同一份索引中其余记录照常生效。
 * 该行为对使用者是正确的（一条写错不该使整个市场不可用），但对维护索引的人是危险的：
 * 拼错一个字段的后果仅仅是该插件不出现在列表里，没有任何报错。
 *
 * 因此本脚本的判定规则必须与两侧的解析器**逐条一致**，且把丢弃升格为错误：
 *   内核  packages/core/src/plugin/market.ts 的 `parseEntry` / `parseInstall`
 *   webui repos/webui-plugin/src/panelstore.ts 的 `parsePanelEntry`
 * 修改任一侧的解析规则时，此处需一并修改。
 *
 * 额外增加三项消费者不做的检查：
 *   - 名称重复。两侧都按"先出现者为准"合并，重复条目中靠后者永远不会被安装。
 *   - `official` 非布尔值。两侧视 `true` 之外一切为 false，写成 `"true"` 字符串
 *     会使官方插件显示为社区插件。
 *   - **写错了地方的版本门**。面板条目里的 `minCore` 与内核条目里的 `minWebui` 都
 *     不会被读取，而作者写下它时想的是"限制版本"—— 静默忽略等于那道门不存在。
 *
 * 用法：node scripts/validate.mjs
 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

/** 合法插件名：与两侧的 NAME_RE 一致 */
const NAME_RE = /^[a-z\d][a-z\d._-]*$/i

/**
 * 保留名，两侧都会拒
 *
 * `NAME_RE` 放行它们 —— 它们全是合法的目录名 —— 而它们落在安装目录之内却会破坏运行环境。
 * 内核靠 `assertPluginName` 在安装那一刻拦，webui 靠 `isUsableName` 在**解析**那一刻拦
 * （故写了这种名字的条目会静默消失，连卡片都不出现）。此处升格为错误，否则作者只看到
 * 「我的条目不见了」。
 */
const RESERVED_NAMES = ["node_modules", "package.json", "dist"]

/** 两份索引的差别，逐份声明而非在校验函数里到处分支 */
const INDEXES = [
  {
    file: "index.json",
    key: "plugins",
    what: "内核插件",
    /** 内核接受两种形状：`{ plugins: [...] }` 与顶层直接是数组 */
    bareArray: true,
    /** 该份索引认的版本门字段 */
    gate: "minCore",
    /** 写在这份索引里不会被读取的版本门 */
    wrongGate: "minWebui"
  },
  {
    file: "webui_index.json",
    key: "panels",
    what: "面板插件",
    /*
     * **面板索引不接受顶层数组。** 顶层键刻意与内核那份不同（`panels` 对 `plugins`）：
     * 若两份都叫 `plugins`，使用者把面板索引填进内核的 `market.sources` 时内核会解析
     * 成功，于是列出一堆装到错地方的条目。放开顶层数组会把这道防线拆掉一半 ——
     * 一个裸数组两边都认。
     */
    bareArray: false,
    gate: "minWebui",
    wrongGate: "minCore"
  }
]

/** 读取一个字符串字段：非字符串或去空白后为空串均按缺失处理（与两侧的 text() 一致） */
function text(record, key) {
  const value = record[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/**
 * 校验 install 字段
 * @param raw 条目的 install 字段
 * @param at 报错位置前缀
 * @param errors 错误收集数组
 */
function checkInstall(raw, at, errors) {
  if (typeof raw !== "object" || raw === null) {
    errors.push(`${at}：缺少 install 对象`)
    return
  }
  const type = text(raw, "type")
  const url = text(raw, "url")
  if (url === undefined) errors.push(`${at}：install.url 缺失`)
  else if (!/^https?:\/\//.test(url)) errors.push(`${at}：install.url 须以 http:// 或 https:// 开头，实为 ${url}`)
  if (type !== "git" && type !== "tarball") {
    errors.push(`${at}：install.type 须为 git 或 tarball，实为 ${type ?? "缺失"}`)
  }
  /*
   * 子目录安装两侧都不支持
   *
   * 面板商店那边是明确定夺（批 21）：`.git` 在仓库根，而装进落点的是子目录，更新时
   * 无从在那个子目录里 fetch + reset。一个仓库要放多枚组件时，让那个包导出多枚 ——
   * 而不是切成多个安装单位。写了 path 的人期待它生效，故此处报错而非忽略。
   */
  if ("path" in raw) {
    errors.push(`${at}：install.path 不被支持。一个仓库即一个包；要放多枚组件请让包导出多枚`)
  }
}

/**
 * 校验一条记录
 * @param raw 索引记录
 * @param i 记录下标
 * @param seen 已出现过的插件名
 * @param spec 该份索引的差别声明
 * @param errors 错误收集数组
 */
function checkEntry(raw, i, seen, spec, errors) {
  const at = `第 ${i + 1} 条`
  if (typeof raw !== "object" || raw === null) {
    errors.push(`${at}：不是对象`)
    return
  }
  const name = text(raw, "name")
  if (name === undefined) {
    errors.push(`${at}：缺少 name`)
  } else if (!NAME_RE.test(name) || name.startsWith(".")) {
    // 该名称会参与安装目录的路径拼接，故采用白名单：路径越界校验能拦住 `../`，
    // 但拦不住 `.git`、`node_modules` 这类落在目录之内却会破坏运行环境的名称
    errors.push(`${at}：name 不合法（须匹配 ${NAME_RE} 且不以点开头），实为 ${name}`)
  } else if (RESERVED_NAMES.includes(name.toLowerCase())) {
    errors.push(`${at}：name 为保留名 —— ${name}。它会与安装目录里的同名文件或目录相撞`)
  } else if (seen.has(name)) {
    errors.push(`${at}：name 重复 —— ${name}。按先出现者为准，本条永远不会被安装`)
  } else {
    seen.add(name)
  }

  checkInstall(raw.install, `${at}（${name ?? "无名"}）`, errors)

  if ("official" in raw && typeof raw.official !== "boolean") {
    errors.push(`${at}：official 须为布尔值，实为 ${JSON.stringify(raw.official)}。两侧视 true 之外一切为 false`)
  }
  if ("tags" in raw && !Array.isArray(raw.tags)) {
    errors.push(`${at}：tags 须为数组`)
  }

  /*
   * 版本门写错了地方 —— 这一条消费者不查，而它静默失效
   *
   * 面板插件要的能力（api.config、页签注册点、组件数组导出）随 **webui** 版本走，
   * 内核插件的随内核版本走。两个是不同的数字，互相填进去只会得到一道不存在的门。
   */
  if (spec.wrongGate in raw) {
    errors.push(
      `${at}：${spec.wrongGate} 不会被读取 —— ${spec.what}的版本门是 ${spec.gate}。` +
        `写成前者等于没有版本限制`
    )
  }

  /*
   * 面板索引独有的三项：都是「预告」而非事实
   *
   * 组件数要浏览器 `import()` 过才知道，node 侧与依赖要读到包的 package.json 才确定。
   * 故它们仅供列表展示，装完一律以磁盘为准。此处只查类型 —— 数目填错不该让 CI 红，
   * 那不是能在索引里核实的事。
   */
  if (spec.key === "panels") {
    if ("widgets" in raw && (typeof raw.widgets !== "number" || !Number.isInteger(raw.widgets) || raw.widgets < 0)) {
      errors.push(`${at}：widgets 须为非负整数（仅供列表展示，装完以包的 package.json 为准）`)
    }
    for (const flag of ["server", "deps"]) {
      if (flag in raw && typeof raw[flag] !== "boolean") {
        errors.push(`${at}：${flag} 须为布尔值`)
      }
    }
  }
}

/**
 * 校验一份索引
 * @param spec 该份索引的差别声明
 * @returns 错误数组与条目数
 */
async function checkIndex(spec) {
  const file = path.resolve(import.meta.dirname, "..", spec.file)
  let raw
  try {
    raw = JSON.parse(await readFile(file, "utf8"))
  } catch (err) {
    return { errors: [`${spec.file} 无法解析：${err instanceof Error ? err.message : String(err)}`], count: 0 }
  }

  const fromKey = typeof raw === "object" && raw !== null && Array.isArray(raw[spec.key]) ? raw[spec.key] : undefined
  const list = fromKey ?? (spec.bareArray && Array.isArray(raw) ? raw : undefined)
  if (list === undefined) {
    const shape = spec.bareArray ? `数组或含 ${spec.key} 数组的对象` : `含 ${spec.key} 数组的对象`
    return { errors: [`${spec.file} 格式不符：期望${shape}`], count: 0 }
  }

  const errors = []
  const seen = new Set()
  list.forEach((item, i) => checkEntry(item, i, seen, spec, errors))
  return { errors, count: list.length, names: seen.size }
}

/** 入口 */
async function main() {
  let bad = 0
  for (const spec of INDEXES) {
    const { errors, count, names } = await checkIndex(spec)
    if (errors.length > 0) {
      bad += errors.length
      console.error(`${spec.file}（${spec.what}）校验未通过：${errors.length} 项\n`)
      for (const e of errors) console.error(`  · ${e}`)
      console.error("")
      continue
    }
    console.error(`✓ ${spec.file}（${spec.what}）校验通过：${count} 个条目，${names} 个唯一名`)
  }

  if (bad > 0) {
    console.error("以上记录会被静默丢弃，对应插件将不出现在面板中。")
    process.exitCode = 1
  }
}

await main()
