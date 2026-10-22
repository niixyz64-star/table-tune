# TableTune

A table-editing plugin for Obsidian, with stable column widths, merged cells and a compact icon toolbar.

## Version 2.0.0

Requires **Obsidian 1.14.4 or newer**. Tested against Obsidian 1.14.4 on Windows; mobile behavior has not been verified.

- Drag cell borders to resize columns and rows. Typing keeps existing column widths; wide tables can scroll horizontally.
- Merge and split cells. Drag and Shift selections expand to include intersecting merged cells with a continuous rectangular outline.
- Click a cell to place the caret. Drag within text to select part of it; continue beyond the text to select cells.
- Copy and paste cell ranges, including supported external HTML tables, tab-separated text and Markdown tables.
- Insert/delete rows and columns, set horizontal alignment, and choose top/middle/bottom vertical alignment from the icon toolbar.
- Use **Ctrl+Z** to undo and **Ctrl+Y** to redo. Table edits and layout metadata participate in native editor history. On macOS, use Command in place of Ctrl; Command+Shift+Z is also supported for redo.
- Keep tables in the same note independent. The first row uses ordinary text styling rather than forced bold text.
- Select across a table from outside it to highlight it for deletion.

See [CHANGELOG.md](CHANGELOG.md) for release details.

## Installation

### BRAT

Add `niixyz64-star/table-tune` using the BRAT plugin.

### Manual installation

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/niixyz64-star/table-tune/releases/latest).
2. Place all three files in `<vault>/.obsidian/plugins/table-tune/`.
3. Enable TableTune in **Settings → Community plugins**, or reload it after an update.

When upgrading, preserve your existing `data.json`. Back up your vault before installing a major update.

## Usage and storage

Edit tables in **Live Preview**. Drag a cell's right border to change its column width, or its bottom border to adjust row height. Select cells to reveal the floating toolbar. Reading view mirrors stored layout.

Widths, heights, merge regions and alignments are stored in the plugin's `data.json`, per note and table. Operations may insert an invisible table identifier into the first cell so later header edits do not lose its identity. Structural edits and pasted values update the Markdown source. Merges and presentation are plugin-managed and may not appear the same in other Markdown applications.

Undo/redo is session history, not a persistent backup: operations performed before plugin reload or editor restart are not guaranteed to remain undoable. External clipboard support depends on formats supplied by the source application; arbitrary spreadsheet formatting is not preserved.

## 中文说明

2.0.0 新增合并/拆分单元格、连续矩形选区、文字优先拖选、跨应用表格粘贴、横向图标工具栏、水平与垂直对齐，以及原生撤销/重做。修复首行操作丢字、多表格相互影响、缩列宽边框错位及首次输入改变列宽等问题。

请使用 Obsidian 1.14.4 或更新版本。更新时保留 `data.json`，并先备份笔记。合并与样式由插件数据管理，不等同于可移植的 Markdown 原生合并单元格。

## Inspiration / 交互设计参考

TableTune's table interactions are primarily inspired by Feishu Docs. Its table editing feels smooth and intuitive, and this plugin aims to bring a similar interaction experience to Obsidian. This is an independent project, not an official Feishu product or an affiliated project.

觉得飞书文档里的表格交互很丝滑、很好用，因此 TableTune 主要参考了飞书文档的表格交互方式，希望把类似的流畅编辑体验带到 Obsidian 中。本项目为独立开发，与飞书官方无隶属或合作关系。

## License

MIT
