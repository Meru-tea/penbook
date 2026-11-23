# AGENTS.md

本仓库是 [wangcccccct/penbook](https://github.com/wangcccccct/penbook) 的个人维护分支。在此仓库内工作必须遵守以下守则。

## 必须遵守

1. **只改 `src/` 和 `styles.css`**，不要直接修改 `release/` 下的产物；产物由 `npm run build` 生成，已被 `.gitignore` 忽略。
2. **每次提交前必须跑 `npm run build`**，它包含 `tsc --noEmit` 类型检查。类型错误会导致打包失败，不允许跳过。
3. **改动手势相关代码时，必须保留以下行为**，这些是移动端修复的核心，不可回退：
   - 手势记录 `pointerType`，不同指针类型可接管已有手势；
   - 拖动提交判定对比 `original` 快照的实际位移，不依赖 `last` 坐标差；
   - `pointercancel` / `lostpointercapture` 在有位移时提交、无位移时回滚；
   - `pointerMove` 中对象写入目标是 `g.surface.page.items`，不是 `this.page.items`；
   - `pointerDown` 无条件 `preventDefault()`；
   - canvas 保持 `touch-action:none`，`.pb-stage` 保持 `touch-action:pan-y`。
4. **发版必须同步改版本号**：`manifest.json` 的 `version` 与 `versions.json` 保持一致，格式为 `0.3.1-mobile.N`。
5. **BRAT 只读 Release 附件**：任何要让平板更新的改动，都必须构建后重新发布 Release，上传 `main.js`、`manifest.json`、`styles.css` 三个文件。
6. **不得提交密钥、token、个人路径**。仓库是公开的。
7. **上游同步用 rebase**，冲突时保留本分支的手势修复逻辑。

## 环境

- 目标设备：OPPO Pad2，Obsidian 连续滚动模式
- 安装目录：`/sdcard/Documents/University/.obsidian/plugins/penbook`
- 构建：`npm install` 后 `npm run build`，产物在 `release/penbook/`
- npm 镜像：`registry.npmmirror.com`
