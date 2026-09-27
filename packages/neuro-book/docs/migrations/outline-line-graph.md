# 大纲线路规划：线路图格式替换（未绑定发布版本）

本说明属于 Project Workspace 的大纲规划文件，不是 Application State catalog 步骤，Manager 不会执行它，也不需要 `stateMigration` 声明。大纲规划模块尚未随发布版本交付，因此暂不绑定版本号。

## 变化

- 线路规划从每条线路自带节点与边的 `outline/lines/<slug>--<ln-id>.yaml`（`nbook.outline-line/v1`、`v2`）改为：
  - `outline/graphs/<slug>--<gr-id>.yaml`（`nbook.outline-graph/v1`）：每个方案一张共享线路图，节点带格号和行号；
  - `outline/storylines/<slug>--<ln-id>.yaml`（`nbook.outline-line/v3`）：线路只保存勾选的节点 ID、类型、固定状态和分析报告。
- `outline/manifest.yaml` 从 `nbook.outline/v1` 升为 `nbook.outline/v2`，新增 `graphs` 引用。

## 自动行为

- 读取 v1 manifest 时，在内存中丢弃旧的 `lines` 引用，其余条目、伏笔和方案不受影响；下一次规划发布时 manifest 写为 v2。
- 旧 `outline/lines/` 下的文件原样留在磁盘上，不删除、不改写，但不再读取、索引或显示。

## 不兼容

旧线路不做自动转换：旧格式没有格号，无法可靠还原跨线路的先后与分叉、汇合关系。需要保留旧规划时，打开旧线路文件查看节点关联的条目，在新画布上按格号重建节点、连线和线路，再重新分析、固定。

## 回滚

回到旧版本前恢复升级前备份的 `outline/manifest.yaml`。v2 manifest 和新目录不会被旧版本识别，旧版本读取 v2 manifest 会 fail-closed。
