---
name: subagents
description: 为独立调查、编码或审查创建和协调持久后台 Agent。
---

# 子代理协作

把具体、独立的工作交给协作工具。所有 Agent 共用工作区，明确文件归属，保留并发修改。

## 创建工作

spawn_agent 创建 open Agent 并准入首个 Task。省略 model 沿用当前模型；只在用户指定或工作需要其他模型时查 list_subagent_models。explorer 用于只读，worker 用于编码/命令；委派不增加父会话没有的工具。

fork_turns 默认 none；all 继承有效上下文，正整数取完整业务轮次。遇 effective-context-unavailable 改用 none，不从 raw history 重建丢弃内容。

Task timeout 默认 30 分钟，task_timeout_ms 接受 60000..86400000，覆盖 role/config；首次执行 grant 才开始 deadline，steer/wait activation 不延长。

完成/关闭后名称仍保留，应继续已有目标，不重复 spawn 同名。默认每 Main open 32，Main/process active 各 10；closed 不占 open，waiting 释放 active，多余工作按准入顺序排队。

## 继续、恢复和关闭

send_input({target,message})：idle 新 Task，running steer 当前 Task，starting/queued 绑定所选 Task，waiting 为原 Task 申请 active 位、满位等待。以上都不改已有 Task ID/owner/lease/deadline。interrupt:true 停所选 Task 并以消息创建优先新 Task，其余队列保留。

忙 Agent 的独立后续工作可等 Completion 再发；普通忙输入是 steer，用户 UI Alt+Enter 可排 after-current 新工作。

只有 Main 有 resume_agent/close_agent。closed 拒绝所有输入（含 interrupt），先 resume_agent({target})，再 send_input。resume 只恢复目标 idle，沿用冻结 profile/history，零 Task/lease/provider/compact，不自动恢复祖先/后代；已 open 幂等。

收集结果、暂无工作后 close 闲子树。普通 close 要整结构子树 idle；force:true 取消全部 current/queued，再关闭，每个取消 Task 恰一 interrupted Completion。历史/未读保留，cleanup_pending 时等 closed 再恢复，不为腾位取消有用工作，不保留闲置池。

返回 Main 不关闭 Agent；quit/new/switch/reload 强关旧 Main 整树，回去后须显式 resume。

## 等待与汇报

结果自动到达，不轮询 list_agents。下一步确实依赖自己拥有的 Task 时才 wait_agents；它冻结已准入 Task，后续工作不延长 barrier。该 assistant 消息只调用 wait_agents，armed 后结束该轮。

Main/用户给任意后代新 Task，其 Completion 回 Main；child-origin 回该 child，steer 不改 owner。child send_input 只限 open 直接后代；完成用普通 final 或 finish_task。

默认 depth 1 的 child 没有 spawn；maxDepth=2 时可建孙 Agent，孙没有 spawn。恢复权限只可收紧，不扩张。

普通 final 结为 completed；可用但未完用 finish_task partial；需外部动作则 blocked 并带 user-input-required/approval-required/external-prerequisite。后台 Agent 不能打开交互或审批流程。

list_agents 含 closed、生命周期、当前/排队工作、结果及恢复诊断。错误带 code/后续动作；坏配置拒绝新工作，但 Main、close、只读列表和 accepted delivery 继续可用。
