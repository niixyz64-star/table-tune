## TableTune 2.0.1

合并单元格编辑稳定性修复 / Merged-cell editing fixes.

- 2026-10-26 更新：修复中断拖选后监听累积、缓存表格重新挂载后选区失效，并减少无关界面变化触发的重复布局；版本仍为 2.0.1，已安装用户需重新下载/安装此版本以获取修复。
- 修复合并后残留原生多选/只读状态，导致第一次点击不出现光标、无法编辑的问题。
- 修复拖选合并格内文字后，延迟聚焦使选区跳变、Delete 无法连续删除选中文字的问题；同时保护删除后的光标位置。
- 保留拖拽/Shift 单元格多选、复制粘贴列宽/行高和原生撤销重做功能。

Regression coverage includes horizontal/vertical merges, first-click typing, partial text selection and immediate Delete, stale focus callbacks, clipboard operations and native undo/redo. Tests use native selection/history code from Windows Obsidian 1.14.5; mobile behavior has not been verified.

**Requires Obsidian 1.14.4+.**

Download all three assets (`main.js`, `manifest.json`, `styles.css`) to `.obsidian/plugins/table-tune/`, then reload the plugin. Preserve your existing `data.json` and back up your vault before upgrading.

Version 2.0.0 remains available unchanged. Undo/redo is session-scoped. Merged cells and presentation rely on plugin metadata; they are not portable native Markdown formatting. External clipboard support depends on the formats supplied by the source app.

See the README and changelog for full usage and compatibility notes.
