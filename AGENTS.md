# AGENTS.md

本仓库是 [wangcccccct/penbook](https://github.com/wangcccccct/penbook) 的个人维护分支，用于**在 Android 平板上修复移动端手势问题并自行更新**。

## 目标设备

| 项 | 值 |
|---|---|
| 设备 | OPPO Pad2 (OPD2201) |
| Vault | `/sdcard/Documents/University` |
| 插件目录 | `/sdcard/Documents/University/.obsidian/plugins/penbook` |
| Obsidian 布局 | 连续滚动模式 |
| 更新方式 | BRAT，指向本仓库 Release |

## 本分支修复了什么

原始版本在平板上存在三类问题，均已修复：

1. **笔选中后无法拖动**：笔按下建立手势后，换手拖动时 touch 指针无法接管，系统发的 `pointercancel` 直接取消手势。
   → 修复：手势记录 `pointerType`，不同类型指针可以接管（`src/view.ts` pointerDown）。
2. **拖远一点就回弹**：拖动提交判定依赖 `last` 坐标差，阈值 0.1 在缩放坐标下不满足。
   → 修复：改为对比 `original` 快照的**实际对象位移**（`finishGesture`）。
3. **拖动中途被系统打断就整体回滚**：`pointercancel` / `lostpointercapture` 无条件走 `finishGesture(false)`。
   → 修复：真拖过（有位移）就提交，没拖过才回滚。

另外两处辅助改动：

- `pointerDown` 无条件 `preventDefault()`，阻止滚动容器抢手势；
- `styles.css`：canvas 加 `touch-action:none`，`.pb-stage` 加 `touch-action:pan-y`；
- 笔长按 1.5 秒内不弹页面设置菜单（`contextmenu` 处理里判断 `lastPen`）。

## 更新流程

### 第一次：装 BRAT 并添加本仓库

1. Obsidian → 设置 → 第三方插件 → 社区插件市场 → 搜索 **BRAT** → 安装并启用。
2. 打开 BRAT 设置 → **Add Beta plugin** → 填 `Meru-tea/penbook` → Add。
3. BRAT 会拉取本仓库的 Release（tag 为 `0.3.1-mobile`），自动安装到插件目录。

**注意**：BRAT 拉取的是 **Release 附件**（`main.js` / `manifest.json` / `styles.css`），不是源码。所以每次改动都必须重新发 Release。

### 日常更新

改完代码后：

```bash
# 1. 本地构建
npm install          # 首次
npm run build        # 产物在 release/penbook/

# 2. 提交
git add src styles.css
git commit -m "fix: ..."
git push

# 3. 发新 Release（版本号递增，比如 0.3.1-mobile.2）
#    用 gh 或者网页上传 main.js / manifest.json / styles.css
```

4. 在平板 Obsidian 的 BRAT 里点 **Check for updates**，或重启 Obsidian。

### 手动更新（BRAT 抽风时的后备方案）

平板上的插件目录是：
```
/sdcard/Documents/University/.obsidian/plugins/penbook/
```

把 `release/penbook/` 下的 `main.js` 和 `styles.css` 覆盖进去，然后**重启 Obsidian**（或者关掉再打开插件）。

> 注意：插件目录里现在有一堆 `main.js.orig-0.3.1-*` 备份文件，是早前手工改编译产物时留下的，可以删除，不影响使用。

## 版本号约定

- 上游版本：`0.3.1`
- 本分支：`0.3.1-mobile`、`0.3.1-mobile.2` …

每次发新版改 `manifest.json` 的 `version`，并同步 `versions.json`。

## 构建环境

- Node 18+
- `npm install` 用国内镜像：`npm config set registry https://registry.npmmirror.com`
- 构建会跑 `tsc --noEmit` 做类型检查，失败会导致打包中断

## 上游同步

```bash
git remote add upstream https://github.com/wangcccccct/penbook.git
git fetch upstream
git rebase upstream/main
```

同步时注意 `src/view.ts` 的手势部分可能冲突，冲突时保留本分支的修复逻辑。

## 安全提醒

不要在仓库里提交任何密钥、token。BRAT 源是公开的。
