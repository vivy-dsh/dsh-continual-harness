# Skill Owner

Skill Owner 保存暂存候选、人工决定与不可变版本，路径在 `$DSH_HOME/harness/skill-owner`。该目录不能是技能发现根。`harness-owner` provider 只暴露已发布版本，并把加载的指令正文与资源目录钉在对应摘要上。全局 harness 技能只有在磁盘 bundle 逐字节一致且带 harness author/source 标记时才迁移；其他文件不动。

provider 使用 rank 390：项目与自定义用户根保持各自既有优先级，托管版本覆盖默认用户目录副本（rank 400）。同名的高优先级自定义技能可以遮蔽托管版本，发布不会覆盖这个用户选择。

## 发布权限是人工决定

发布只需要一条记录在案的人工批准，不需要验证器、不需要 Docker，也没有 OCI 回退。任何 IPC 调用都不能代替人工批准：

- 暂存走组件通道 `POST /dsh-harness/internal/candidates`，由 `dsh-evolution` 校验调用方持有运行中 Ticket、subject 与冻结计划里的同一份 entry 摘要后转交。
- 批准只走面板 `POST /dsh-continual-harness/api/decide`：要求同源、回环、JSON、宿主会话通过 `connection.requestRejection`、显式 `confirm: true`，并带上审阅时的 bundle 摘要。
- 组件通道里的 `/status` 是只读的，用于 Dream 读取当前 live 版本。

批准记录包含 `candidateId`、`decision`（`approved` / `rejected`）、`bundleDigest`、`decidedAt` 与 `actor: 'panel'`。一个候选只有一条决定：重复提交同一决定是幂等的，改判会被拒绝，必须走新候选。一次批准只能产生一次发布；发布记录保存决定的摘要，数据库替换（决定引用 + 幂等映射 + live 指针）是原子的。

## 面板接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/dsh-continual-harness/api/pending` | 待审候选（含正文、附件清单、摘要）与当前 live 版本 |
| POST | `/dsh-continual-harness/api/decide` | `{candidateId, decision, expectedBundleDigest, confirm: true}`；批准即发布 |

`GET` 不受同源限制（便于面板初始化），`POST` 必须带 `origin`。缺宿主会话服务时接口 fail-closed 返回 503，不会退化成无鉴权写入。

## 拒绝条件

候选正文为空、超过 1 MiB、`files` 键不是 `scripts/` 或 `references/` 前缀的相对路径、正文引用的附件缺失、候选摘要被篡改、live 基线已前进、同名用户技能已存在——以上任一都拒绝，不写 live。

回滚是另一个指向历史不可变版本的候选，需要同样的批准。删除走候选生命周期，不能直接改指针。

自动验证环境（隔离执行器、测试套件、Python 工作台等）如何提供仍是待决策项，见 `TODOLIST.md` 的 DV-EV-014；本插件在决策前不引入新的运行时依赖。
