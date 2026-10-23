## TableTune 2.0.0

表格编辑大版本更新 / Major table-editing update.

**2026-10-23 同版本替换更新：**新增「清空内容」橡皮擦图标，清空选中单元格内容，保留合并关系、列宽与对齐，并支持撤销/重做。已安装旧 2.0.0 的用户可能需要手动重新下载覆盖，版本号保持不变。

首行合并后文字消失的反馈仍在排查，本次替换不代表该问题已解决。

- 合并与拆分单元格，拖拽/Shift 选区自动完整覆盖合并格。
- 单击放置光标，格内优先选择文字，支持跨单元格复制与外部表格粘贴。
- 简约横向图标工具栏，支持行列操作、水平及顶部/居中/底部对齐。
- 原生 Ctrl+Z 撤销、Ctrl+Y 重做，表格内容和布局元数据一起撤销。
- 修复首行丢字、多表格互相影响、拖拽列宽回弹和合并格极限缩宽错位。
- 首次输入及后续文字编辑保持列宽，手动拖拽边界调整宽度。

**Requires Obsidian 1.14.4+. Verified on Windows with Obsidian 1.14.4.**

Download all three assets (`main.js`, `manifest.json`, `styles.css`) to `.obsidian/plugins/table-tune/`, then reload the plugin. Preserve your existing `data.json` and back up your vault before upgrading.

Undo/redo is session-scoped. Merged cells and presentation rely on plugin metadata; they are not portable native Markdown formatting. External clipboard support depends on the formats supplied by the source app.

See the README and changelog for full usage and compatibility notes.
