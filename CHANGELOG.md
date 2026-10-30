# Changelog

## 0.1.0

首个版本。

- 执行前静态分级：每条 `pwsh` / `powershell` 命令在 `tools/pre-execute` 上被同步打一次分，
  风险档为 `none` / `low` / `medium` / `high`，评分与命中项一起返回。
- 四类必测特征：**删除**、**覆盖**、**网络下载**、**触碰凭据**；另加三类实测同样致命的：
  动态执行（`iex` / `-EncodedCommand` / `ScriptBlock::Create`）、系统改动、权限改动。
- 组合升级：下载且执行、读凭据且外发，各自直接升到 `high`。
- 高风险二次确认，两个通道：面板内确认（默认优先，开着面板时命令停住等人点，超时算拒绝）
  与 harness 原生审批（面板没开时；approval policy 为 `never` 时为失败关闭）。
- 全量本地审计：每条命令一行 JSON 到 `$DSH_HOME/ps-preflight-audit.jsonl`，含档位、评分、
  分类、命中 id、决定与**脱敏后**的命令；等待确认的高风险命令额外记一行结论，用
  `resolutionOf` 关联。文件超过 2 MB 轮转一次到 `.1`。
- 对话视图「预检」面板：计数、待确认队列、最近记录，以及一个「试一试」的干跑输入框
  （只判分级，不执行）。
- 零依赖构建（`scripts/build.mjs` 复制 host 源码、内联 client 样式），零运行时依赖。
