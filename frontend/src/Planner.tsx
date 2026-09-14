import { useEffect, useState } from "react";
import {
  Sparkles,
  Plus,
  ArrowLeft,
  GitBranch,
  CalendarDays,
  Check,
  Trash2,
} from "lucide-react";
import "./planner.css";
import {DraftAssistant, HourEstimate, HourTimeline, type AssistantData} from './DraftAssistant';
import { describePlanField, normalizePlanInput } from "./plan-input";
import { pLevels } from "./p-level";

type Field = { choices: string[]; detail: string };
export type PlanInput = Record<
  "goal" | "current" | "timing" | "limits" | "resources" | "outcome",
  Field
>;
export type PlanNode = {
  hours?: number;
  hoursHigh?: number;
  estimateBasis?: string;
  refs?: string[];
  pLevel?: string;
  id: string;
  title: string;
  deliverable: string;
  days: number;
  waitDays: number;
  dependsOn: string[];
  priority: string;
  mode: string;
  owner: string;
  reason: string;
  start: number;
  end: number;
  critical: boolean;
};
export type Plan = {
  history?: {created: string; kind: string; nodes: PlanNode[]; tasks?: {id: string; title: string; status: string; deadline?: string}[]}[];
  inputHistory?: {created: string; input: PlanInput}[];
  sourceTaskId?: string;
  id: string;
  input: PlanInput;
  title: string;
  summary: string;
  assumptions: string[];
  questions: string[];
  nodes: PlanNode[];
  status: string;
  created: string;
  source: string;
  totalDays: number;
};
type Props = {
  assistants: Record<string, AssistantData>;
  version: number;
  deletedPlans: {plan: Plan}[];
  openRequest?: { id: string; key: number; sourceTaskId?: string };
  plans: Plan[];
  tasks: { id: string; planId?: string; nodeId?: string; status: string; title?: string; deadline?: string; notes?: string }[];
  editTask: (id: string) => void;
  busy: boolean;
  configured: boolean;
  configure: () => void;
  run: (
    path: string,
    body: unknown,
    method?: string,
    signal?: AbortSignal,
  ) => Promise<Plan[] | undefined>;
};
type DirectionFieldsProps = {
  input: PlanInput;
  setInput: (input: PlanInput) => void;
  disabled: boolean;
  idPrefix: string;
};
function DirectionFields({ input, setInput, disabled, idPrefix }: DirectionFieldsProps) {
  return <div className="plan-input-grid">
    {sections.map((s, i) => (
      <fieldset key={s.key} disabled={disabled} className={s.key === "goal" ? "goal-field" : ""}>
        <legend><span>{String(i + 1).padStart(2, "0")}</span> {s.title}</legend>
        <p>{s.hint}</p>
        <div className="plan-chips">
          {s.choices.map((c) => (
            <button type="button" key={c} aria-pressed={input[s.key].choices.includes(c)} onClick={() =>
              setInput({...input, [s.key]: {...input[s.key], choices: input[s.key].choices.includes(c)
                ? input[s.key].choices.filter((x) => x !== c) : [...input[s.key].choices, c]}})}>{c}</button>
          ))}
        </div>
        <label htmlFor={`${idPrefix}-${s.key}`}>{s.key === "goal" ? "你的大目标（必填）" : "补充细节（可选）"}</label>
        <input id={`${idPrefix}-${s.key}`} required={s.key === "goal"} maxLength={2000} value={input[s.key].detail}
          placeholder={s.placeholder} onChange={(e) => setInput({...input, [s.key]: {...input[s.key], detail: e.target.value}})} />
      </fieldset>
    ))}
  </div>;
}
const sections: {
  key: keyof PlanInput;
  title: string;
  hint: string;
  choices: string[];
  placeholder: string;
}[] = [
  {
    key: "goal",
    title: "大目标",
    hint: "必填 · 想推进什么？零散地说也可以。",
    choices: [
      "改善现有问题",
      "建立新机制",
      "交付一个项目",
      "探索一个方向",
      "个人成长",
    ],
    placeholder: "例如：想改善家长反馈，减少反复催办……",
  },
  {
    key: "current",
    title: "现状",
    hint: "可选 · 已经走到哪一步？",
    choices: [
      "还没开始",
      "已有一些尝试",
      "正在推进",
      "遇到阻碍",
      "情况还不清楚",
    ],
    placeholder: "例如：目前靠班主任逐个追，已经整理了部分投诉",
  },
  {
    key: "timing",
    title: "时间意向",
    hint: "可选 · 是期待，还是不能改的期限？",
    choices: [
      "暂不设期限",
      "尽快看到进展",
      "本月有初步成果",
      "先小范围试行",
      "有硬性截止日期",
    ],
    placeholder: "例如：最好下个月看到变化；或必须在 10 月 15 日前完成",
  },
  {
    key: "limits",
    title: "限制",
    hint: "可选 · 有哪些不能突破的边界？",
    choices: [
      "不增加预算",
      "不增加现有工作量",
      "减少我日常跟进",
      "保持现有流程稳定",
      "先控制试错范围",
    ],
    placeholder: "例如：别增加老师填表的工作，预算不超过……",
  },
  {
    key: "resources",
    title: "资源线索",
    hint: "可选 · 有谁或什么可能帮得上忙？",
    choices: [
      "主要由我推进",
      "有同事可以协助",
      "可以考虑外部协助",
      "已有材料或工具",
      "资源还不确定",
    ],
    placeholder: "例如：小王可能能帮忙，我每周能投入半天",
  },
  {
    key: "outcome",
    title: "暂定成果",
    hint: "可选 · 看见什么，会觉得这次有进展？",
    choices: [
      "形成可讨论的方案",
      "完成一次试点",
      "交付可使用的成果",
      "验证是否值得继续",
      "让某项指标改善",
    ],
    placeholder: "例如：先在一个年级跑通反馈流程，家长不用反复催",
  },
];
const modes: Record<string, string> = {
  self: "亲自执行",
  review: "他人执行，我把关",
  delegate: "委派执行",
};
const freshInput = (): PlanInput => ({
  goal: { choices: [], detail: "" },
  current: { choices: [], detail: "" },
  timing: { choices: [], detail: "" },
  limits: { choices: [], detail: "" },
  resources: { choices: [], detail: "" },
  outcome: { choices: [], detail: "" },
});

export function Planner({
  assistants,
  version,
  deletedPlans,
  openRequest,
  editTask,
  plans,
  tasks,
  busy: requestBusy,
  configured,
  configure,
  run,
}: Props) {
  const [assistantBusy,setAssistantBusy]=useState(false);
  const busy=requestBusy||assistantBusy;
  const [input, setInput] = useState<PlanInput>(freshInput);
  const [sourceTaskId, setSourceTaskId] = useState("");
  const [screen, setScreen] = useState<"list" | "new" | "plan">("list");
  const [draft, setDraft] = useState<Plan | null>(null);
  const [dirty, setDirty] = useState(false);
  const [visual, setVisual] = useState("network");
  const [notice, setNotice] = useState("");
  const [beforeRemoval, setBeforeRemoval] = useState<PlanNode[] | null>(null);
  const [editingDirections, setEditingDirections] = useState(false);
  const [directionInput, setDirectionInput] = useState<PlanInput>(freshInput);
  const open = (p: Plan) => {
    setDraft(structuredClone(p));
    setDirty(false);
    setScreen("plan");
    setNotice("");
    setBeforeRemoval(null);
    setEditingDirections(false);
    setDirectionInput(normalizePlanInput(p.input));
  };
  useEffect(() => {
    if (!openRequest) return;
    if (dirty) {
      setNotice("当前计划有未保存修改，请先保存，再从待办页打开目标。");
      return;
    }
    if (openRequest.sourceTaskId) {
      const source = tasks.find(t => t.id === openRequest.sourceTaskId);
      if (!source) return;
      const next = freshInput();
      next.goal.detail = source.title || "";
      next.current.detail = source.notes || "";
      next.timing.detail = source.deadline ? `目标截止：${source.deadline}` : "";
      setInput(next);
      setSourceTaskId(source.id);
      setScreen("new");
      setNotice("");
      return;
    }
    const selected = plans.find(p => p.id === openRequest.id);
    if (selected) open(selected);
  }, [openRequest]);
  function changeNode(id: string, patch: Partial<PlanNode>) {
    if (!draft) return;
    setDraft({
      ...draft,
      nodes: draft.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    });
    setDirty(true);
  }
  async function generate() {
    const result = await run("/plans/generate", { input, sourceTaskId });
    if (result?.length) {
      open(result[result.length - 1]);
      setInput(freshInput());
      setSourceTaskId("");
    }
  }
  async function save() {
    if (!draft) return;
    const result = await run("/plans", { plan: {...draft, history: undefined} }, "PUT");
    const saved = result?.find((p) => p.id === draft.id);
    if (saved) {
      open(saved);
      setNotice("修改已保存，网络图与排期已重新计算。");
    }
  }
  async function saveDirections() {
    if (!draft) return;
    const result = await run("/plans/input", {planId: draft.id, input: directionInput});
    const saved = result?.find((p) => p.id === draft.id);
    if (saved) {
      open(saved);
      setNotice(locked
        ? "方向调整已保存。已加入待办的执行项未自动改动；如需按新方向重排，请先撤回为草案。"
        : "方向调整已保存。可在检查环节后让 AI 按新方向重新编排。");
    }
  }
  async function replan() {
    if (!draft) return;
    const empty = draft.nodes.length === 0;
    setNotice(empty
      ? "AI 正在根据目标重新生成一份行动路径与初步排期……"
      : "AI 正在根据这些环节重新判断先后、并行、投入与分工……");
    const result = await run("/plans/replan", {plan: {...draft, history: undefined}});
    const saved = result?.find(p => p.id === draft.id);
    if (saved) { open(saved); setNotice(empty ? "AI 已重新生成行动路径与初步排期，请检查后继续调整。" : "AI 编排已保存为草案。环节清单已保留，任务网络与甘特图已更新，请检查后确认。"); }
    else setNotice("本次编排未保存。你的编辑仍保留在这里，可以修改后重试。");
  }
  async function withdraw() {
    if (!draft) return;
    const result = await run("/plans/withdraw", {planId: draft.id});
    const p = result?.find(p => p.id === draft.id);
    if (p) open(p);
    if (p) setNotice("已撤回草案：现在可以添加、移除或展开修改环节；完成后让 AI 重新编排。");
  }
  function addNode() {
    if (!draft) return;
    const used = new Set([
      ...draft.nodes,
      ...(beforeRemoval || []),
      ...(draft.history || []).flatMap(r => r.nodes),
    ].map(n => n.id));
    let number = 1;
    while (used.has("T" + number)) number++;
    const id = "T" + number;
    setDraft({...draft, nodes: [...draft.nodes, {
      id, title: "新增任务", deliverable: "请补充交付物", days: 1,
      waitDays: 0, dependsOn: [], priority: "medium", mode: "self",
      owner: "我", reason: "人工补充，待确认分工", start: 0, end: 1,
      critical: false,
    }]});
    setDirty(true);
    setNotice(`已添加 ${id}。展开它可以修改名称、产出和分工，再让 AI 重新编排。`);
  }
  function removeNode(id: string) {
    if (!draft) return;
    setBeforeRemoval(structuredClone(draft.nodes));
    setDraft({...draft, nodes: draft.nodes
      .filter((node) => node.id !== id)
      .map((node) => ({...node, dependsOn: node.dependsOn.filter((dependency) => dependency !== id)}))});
    setDirty(true);
    setNotice(`已删除 ${id}，可撤销这次删除。重新编排后再检查行动路径。`);
  }
  function removeAllNodes() {
    if (!draft || !window.confirm(`删除全部 ${draft.nodes.length} 个任务？你可以立即撤销，或添加新的任务后再保存。`)) return;
    setBeforeRemoval(structuredClone(draft.nodes));
    setDraft({...draft, nodes: []});
    setDirty(true);
    setNotice("已删除全部任务。可撤销，或添加至少一个新任务后重新编排并保存。");
  }
  const locked = draft?.status === "accepted";
  return (
    <section className="planner">
      {screen === "list" && (
        <>
          <div className="plan-welcome">
            <div className="plan-symbol">
              <GitBranch size={30} />
            </div>
            <div>
              <p className="eyebrow">FROM GOAL TO ACTION</p>
              <h2>把一个大目标，变成能开始的计划。</h2>
              <p>
                写下目标，AI 帮你粗拆行动、梳理依赖，并建议你在哪些节点介入。
              </p>
              <button className="primary" onClick={() => { setInput(freshInput()); setSourceTaskId(""); setScreen("new"); }}>
                <Plus size={17} />
                创建目标计划
              </button>
            </div>
          </div>
          <div className="plan-section-heading">
            <h2>我的目标计划</h2>
            <span>{plans.length} / 50 份</span>
          </div>
          {!plans.length && (
            <p className="muted">
              还没有计划。只写一句大目标也能开始，其他信息都可跳过。
            </p>
          )}
          <div className="plan-cards">
            {[...plans].reverse().map((p) => (
              <button className="plan-card" key={p.id} onClick={() => open(p)}>
                <span className="plan-badge">
                  {p.status === "accepted" ? "已加入待办" : "可编辑草案"}
                </span>
                <h3>{p.title}</h3>
                <p>{p.summary}</p>
                <small>
                  {p.nodes.length} 个任务 · {p.nodes.some(n=>n.hours) ? '小时级工作量' : `估计 ${p.totalDays} 天`} ·{" "}
                  {new Date(p.created).toLocaleDateString("zh-CN")}
                </small>
              </button>
            ))}
          </div>
          {!!deletedPlans.length && <details><summary>大目标回收站 · {deletedPlans.length} 项</summary>
            {deletedPlans.map(({plan}) => <div key={plan.id} className="plan-actions"><span>{plan.title}</span><button className="secondary" disabled={busy} onClick={async () => { await run("/plans/restore", {planId: plan.id}); }}>恢复大目标</button><button className="secondary" disabled={busy} onClick={async () => {
              if (!window.confirm(`永久删除“${plan.title}”？删除后无法从应用恢复。程序会先保留一份本机恢复备份。`)) return;
              await run("/plans/purge", {planId: plan.id});
            }}>永久删除</button></div>)}
          </details>}
        </>
      )}
      {screen === "new" && (
        <>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => setScreen("list")}
          >
            <ArrowLeft size={16} />
            返回计划列表（保留输入）
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void generate();
            }}
          >
            <div className="plan-form-intro">
              <h2>先说说，你想推进什么？</h2>
              <p>
                只需填写大目标。每项可点选，也可直接补充；不确定的内容原样写就好。
              </p>
            </div>
            <DirectionFields input={input} setInput={setInput} disabled={busy} idPrefix="plan" />
            {!configured && (
              <div className="plan-notice">
                生成粗拆需要连接 AI。
                <button
                  type="button"
                  className="text-button"
                  onClick={configure}
                >
                  去配置 MiMo
                </button>
                输入在本次页面会话中保留。
              </div>
            )}
            <div className="plan-actions">
              <span>生成后先保存为草案，由你决定是否加入待办。</span>
              <button
                className="primary"
                disabled={busy || !configured || !input.goal.detail.trim()}
              >
                <Sparkles size={16} />
                {busy ? "正在理解目标并生成计划…" : "生成第一轮粗拆"}
              </button>
            </div>
            {busy && (
              <p className="muted" role="status">
                通常需要几十秒，请稍候。系统会检查依赖关系并计算初步排期。
              </p>
            )}
          </form>
        </>
      )}
      {screen === "plan" && draft && (
        <div className="plan-detail-with-assistant"><div className="plan-detail-content">
          <button
            className="text-button"
            disabled={busy || dirty}
            onClick={() => setScreen("list")}
          >
            <ArrowLeft size={16} />
            返回计划列表{dirty ? "（请先保存修改）" : ""}
          </button>
          {notice && (
            <p className="plan-notice" role="status">
              {notice}
            </p>
          )}
          <div className="plan-detail-heading">
            <div>
              <span className="plan-badge">
                {locked
                  ? "已确认 · 执行状态与待办同步"
                  : "AI 粗拆 · 可修改草案"}
              </span>
              <h2>{draft.title}</h2>
              <p>{draft.summary}</p>
            </div>
            <div className="plan-total">
              <strong>{draft.nodes.some(n=>n.hours) ? draft.nodes.reduce((v,n)=>v+(n.hours||0),0).toFixed(1) : draft.totalDays}</strong>
              <span>{draft.nodes.some(n=>n.hours) ? '小时 / 估算下界' : '天 / 初步估算'}</span>
            </div>
          </div>
          <div className={"plan-edit-bar " + (locked ? "confirmed" : "draft") }>
            {locked ? <>
              <div>
                <strong>想调整这份计划？</strong>
                <span>先撤回为草案，再添加、移除或修改环节。</span>
              </div>
              <button className="primary" disabled={busy} onClick={withdraw}>编辑计划（撤回为草案）</button>
            </> : <>
              <div>
                <strong>草案编辑区</strong>
                <span>可添加环节；展开任一环节可修改或移除。完成后交给 AI 更新网络和甘特图。</span>
              </div>
              <div className="plan-edit-actions">
                <button className="secondary" disabled={busy || draft.nodes.length >= 30} onClick={addNode}><Plus size={15}/>添加环节</button>
                <button className="primary" disabled={busy || !configured || !draft.nodes.length} onClick={replan}><Sparkles size={16}/>AI 重新编排</button>
              </div>
            </>}
          </div>
          <details className="plan-original" open={editingDirections}>
            <summary>查看输入 · 六个方向</summary>
            {sections.map((s) => (
              <p key={s.key}>
                <strong>{s.title}：</strong>
                {describePlanField(draft.input?.[s.key])}
              </p>
            ))}
            {!editingDirections && <button className="secondary plan-direction-button" disabled={busy} onClick={() => {
              setDirectionInput(normalizePlanInput(draft.input));
              setEditingDirections(true);
            }}>调整六个方向</button>}
            {editingDirections && <form className="plan-direction-editor" onSubmit={(e) => { e.preventDefault(); void saveDirections(); }}>
              <p className="muted">可随时点选或补充方向。保存后保留本次调整前的输入记录。</p>
              <DirectionFields input={directionInput} setInput={setDirectionInput} disabled={busy} idPrefix="direction" />
              <div className="plan-edit-actions">
                <button type="button" className="secondary" disabled={busy} onClick={() => setEditingDirections(false)}>取消</button>
                <button className="primary" disabled={busy || !directionInput.goal.detail.trim()}>保存方向调整</button>
              </div>
            </form>}
            {!!draft.inputHistory?.length && <details className="plan-input-history">
              <summary>查看之前输入 · {draft.inputHistory.length} 次</summary>
              {[...draft.inputHistory].reverse().map((revision, index) => <div key={revision.created}>
                <p><strong>第 {draft.inputHistory!.length - index} 次调整前</strong></p>
                {sections.map((s) => <p key={s.key}><strong>{s.title}：</strong>{describePlanField(revision.input?.[s.key])}</p>)}
              </div>)}
            </details>}
          </details>
          <div className="plan-caveats">
            <div>
              <h3>暂定假设</h3>
              <ul>
                {draft.assumptions?.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>后续可补充</h3>
              {draft.questions?.length ? (
                <ul>
                  {draft.questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              ) : (
                <p>可以先检查交付物、投入天数和执行角色。</p>
              )}
            </div>
          </div>
          <div className="plan-section-heading">
            <h2>行动路径与初步排期</h2>
            <div className="plan-chips">
              <button
                aria-pressed={visual === "network"}
                onClick={() => setVisual("network")}
              >
                <GitBranch size={15} />
                任务网络
              </button>
              <button
                aria-pressed={visual === "timeline"}
                onClick={() => setVisual("timeline")}
              >
                <CalendarDays size={15} />
                甘特图 / 时间安排
              </button>
            </div>
          </div>
          <p className="muted">
            {draft.nodes.some(n=>n.hours) ? '小时工作量与日历时间分别估算；图中箭头表示任务依赖。' : <>
            从第 1
            天起算，未映射到日历。按每天投入一天估算；同一执行角色的投入不重叠，等待期可并行。仅计算本计划，不含现有待办、节假日和跨计划容量。红色表示按依赖计算的关键路径，未宣称全局最优。
            </>}
          </p>
          <HourEstimate nodes={draft.nodes} weeklyHours={assistants[draft.id]?.weeklyHours||0}/>
          {dirty ? (
            <div className="plan-notice">
              环节已修改。点击“AI 重新编排行动路径与排期”生成新的任务网络与甘特图。
            </div>
          ) : visual === "network" ? (
            <Network nodes={draft.nodes} />
          ) : draft.nodes.some(n=>n.hours) ? (
            <HourTimeline nodes={draft.nodes} weeklyHours={assistants[draft.id]?.weeklyHours||0}/>
          ) : (
            <div className="plan-timeline">
              {draft.nodes.map((n) => (
                <div className="timeline-row" key={n.id}>
                  <span>
                    {n.id} · {n.title}
                  </span>
                  <div className="timeline-track">
                    <div
                      className={n.critical ? "critical-bar" : ""}
                      style={{
                        left: `${(n.start / draft.totalDays) * 100}%`,
                        width: `${((n.end - n.start) / draft.totalDays) * 100}%`,
                      }}
                      title={`投入 ${n.days} 天，等待 ${n.waitDays} 天`}
                    >
                      {n.start + 1}—{n.end}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="plan-section-heading">
            <h2>逐项检查与分工</h2>
            <div className="plan-node-heading-actions">
              <span>{draft.nodes.length} 个任务</span>
              {!locked && <button className="secondary danger-button" disabled={busy || !draft.nodes.length} onClick={removeAllNodes}>
                <Trash2 size={15} /> 删除全部任务
              </button>}
            </div>
          </div>
          <p className="muted">
            可以增删环节、修改名称和预期产出，再让 AI 重新编排依赖、工期与分工。执行者均为建议。
          </p>
          <div className="plan-node-list">
            {draft.nodes.map((n) => {
              const task = tasks.find(
                (t) => t.planId === draft.id && t.nodeId === n.id,
              );
              const unmet = n.dependsOn.filter(
                (d) =>
                  tasks.find((t) => t.planId === draft.id && t.nodeId === d)
                    ?.status !== "done",
              );
              return (
                <details key={n.id} className="plan-node">
                  {!locked && <button
                    type="button"
                    className="plan-node-delete"
                    aria-label={`删除 ${n.id}：${n.title}`}
                    disabled={busy}
                    onClick={() => removeNode(n.id)}
                  ><Trash2 size={16} /> 删除</button>}
                  <summary>
                    <b>{n.id}</b>
                    <span>
                      {task?.title || n.title}
                      <small>
                        {modes[n.mode]} · {n.owner} · 投入 {n.hours ? `${n.hours}—${n.hoursHigh} 小时` : `${n.days} 天`} / 等待{" "}
                        {n.waitDays} 天
                      </small>
                    </span>
                    <em>
                      {locked
                        ? task?.status === "done"
                          ? "已完成"
                          : task?.status === "skipped"
                            ? "已决定不做"
                            : unmet.length
                              ? "等待前置任务"
                              : "可以开始"
                        : n.critical && !n.hours
                          ? "关键路径"
                          : ""}
                    </em>
                  </summary>
                  {locked && task && <p><button className="secondary" onClick={() => editTask(task.id)}>{task.deadline ? `行动截止 ${task.deadline.replace("T", " ")}` : "设置行动截止日"} · 编辑执行项</button></p>}
                  <fieldset disabled={busy || locked}>
                    <div className="plan-edit-grid">
                      <label>
                        任务名称
                        <input
                          aria-label={`${n.id}任务名称`}
                          maxLength={300}
                          value={n.title}
                          onChange={(e) =>
                            changeNode(n.id, { title: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        交付物
                        <input
                          maxLength={1000}
                          value={n.deliverable}
                          onChange={(e) =>
                            changeNode(n.id, { deliverable: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        {n.hours ? '投入小时下界' : '投入天数'}
                        <input
                          type="number"
                          min={n.hours ? 0.1 : 1}
                          max={n.hours ? 2000 : 60}
                          step={n.hours ? 0.5 : 1}
                          value={n.hours || n.days}
                          onChange={(e) =>
                            changeNode(n.id, n.hours ? {hours:Number(e.target.value),hoursHigh:Math.max(n.hoursHigh||0,Number(e.target.value))} : { days: Number(e.target.value) })
                          }
                        />
                      </label>
                      {!!n.hours&&<><label>投入小时上界<input type="number" min={n.hours} max={2000} step={0.5} value={n.hoursHigh} onChange={e=>changeNode(n.id,{hoursHigh:Number(e.target.value)})}/></label><label>估算依据<textarea value={n.estimateBasis||''} maxLength={900} onChange={e=>changeNode(n.id,{estimateBasis:e.target.value})}/></label></>}
                      <label>
                        等待天数
                        <input
                          type="number"
                          min={0}
                          max={90}
                          value={n.waitDays}
                          onChange={(e) =>
                            changeNode(n.id, {
                              waitDays: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        执行优先级
                        <select
                          value={n.pLevel || ""}
                          onChange={(e) =>
                            changeNode(n.id, { pLevel: e.target.value })
                          }
                        >
                          <option value="">待评定</option>
                          {Object.entries(pLevels).map(([level, description]) => <option key={level} value={level}>{level} · {description}</option>)}
                        </select>
                      </label>
                      <label>
                        你的介入方式
                        <select
                          value={n.mode}
                          onChange={(e) =>
                            changeNode(n.id, {
                              mode: e.target.value,
                              ...(e.target.value === "self"
                                ? { owner: "我" }
                                : n.owner === "我"
                                  ? { owner: "协助者（待确认）" }
                                  : {}),
                            })
                          }
                        >
                          {Object.entries(modes).map(([v, label]) => (
                            <option key={v} value={v}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        执行者／角色建议
                        <input
                          disabled={n.mode === "self"}
                          maxLength={80}
                          value={n.owner}
                          onChange={(e) =>
                            changeNode(n.id, { owner: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        分工理由
                        <input
                          maxLength={600}
                          value={n.reason}
                          onChange={(e) =>
                            changeNode(n.id, { reason: e.target.value })
                          }
                        />
                      </label>
                    </div>
                    <p>前置任务（可多选，不选表示可独立开始）</p>
                    <div className="plan-chips">
                      {draft.nodes
                        .filter((x) => x.id !== n.id)
                        .map((x) => (
                          <button
                            type="button"
                            key={x.id}
                            aria-pressed={n.dependsOn.includes(x.id)}
                            title={x.title}
                            onClick={() =>
                              changeNode(n.id, {
                                dependsOn: n.dependsOn.includes(x.id)
                                  ? n.dependsOn.filter((d) => d !== x.id)
                                  : [...n.dependsOn, x.id],
                              })
                            }
                          >
                            {x.id} · {x.title}
                          </button>
                        ))}
                    </div>
                  </fieldset>
                </details>
              );
            })}
          </div>
          {!locked && beforeRemoval && <button className="secondary" disabled={busy} onClick={() => {
            const removed = beforeRemoval.filter(n => !draft.nodes.some(x => x.id === n.id));
            setDraft({...draft, nodes: [...draft.nodes, ...removed]});
            setBeforeRemoval(null); setDirty(true); setNotice("已恢复被移除的环节，请重新编排依赖。");
          }}>撤销上次移除</button>}
          {!locked && (
            <button
              className="secondary"
              disabled={busy || draft.nodes.length >= 30}
              onClick={addNode}
            >
              <Plus size={15} />
              添加环节
            </button>
          )}
          <div className="plan-actions">
            <button className="secondary" disabled={busy} onClick={async () => {
              const result = await run("/plans/delete", {planId: draft.id});
              if (result) { setDraft(null); setDirty(false); setScreen("list"); setNotice("大目标及关联任务已移入回收站，可随时恢复。"); }
            }}>删除大目标（移入回收站）</button>
            {locked ? (
              <>
              <p>
                <Check size={16} />
                已加入待办。撤回后可增删环节；原完成记录和截止日会留存。
              </p>
              <button className="secondary" disabled={busy} onClick={withdraw}>撤回草案</button>
              </>
            ) : (
              <>
                <span>
                  {dirty
                    ? "有未保存修改，可直接交给 AI 重新编排。"
                    : "确认后开始执行；未改动的旧环节沿用进度，变更环节重新开始。"}
                </span>
                <button className="primary" disabled={busy || !configured} onClick={replan}><Sparkles size={16}/>{draft.nodes.length ? "AI 重新编排行动路径与排期" : "AI 重新生成行动路径与排期"}</button>
                <button
                  className="secondary"
                  disabled={busy || !dirty}
                  onClick={save}
                >
                  按手动设置保存并重算
                </button>
                <button
                  className="primary"
                  disabled={busy || dirty}
                  onClick={async () => {
                    const result = await run("/plans/accept", {
                      planId: draft.id,
                    });
                    const p = result?.find((p) => p.id === draft.id);
                    if (p) {
                      open(p);
                      setNotice("计划已加入待办；原有任务顺序保持不变。");
                    }
                  }}
                >
                  确认计划并加入待办
                </button>
              </>
            )}
          </div>
          {!!draft.history?.length && <details className="plan-node">
            <summary>历史版本与执行记录 · {draft.history.length} 份</summary>
            {[...draft.history].reverse().map((revision, i) => <div key={i} style={{padding: 16}}>
              <strong>{revision.kind === "withdraw" ? "撤回前的执行记录" : revision.kind === "edit" ? "手动编辑前的草案" : "重新编排前的草案"} · {new Date(revision.created).toLocaleString()}</strong>
              <p>{revision.nodes.length} 个环节</p>
              {revision.tasks?.map(t => <p key={t.id}>{t.title} · {t.status === "done" ? "已完成" : t.status === "skipped" ? "已跳过" : "未完成"}{t.deadline ? ` · 截止 ${t.deadline.replace("T", " ")}` : ""}</p>)}
              {!locked && <button className="secondary" disabled={busy} onClick={() => {setDraft({...draft, nodes: structuredClone(revision.nodes)}); setDirty(true); setBeforeRemoval(null); setNotice("历史环节已恢复到编辑区，请重新编排后保存。");}}>恢复此版本的环节</button>}
            </div>)}
          </details>}
        </div><DraftAssistant onBusy={setAssistantBusy} key={draft.id} plan={draft} data={assistants[draft.id]} version={version} busy={busy} dirty={dirty} configured={configured} run={run} adopt={open}/></div>
      )}
    </section>
  );
}

function Network({ nodes }: { nodes: PlanNode[] }) {
  const layers = new Map<string, number>();
  for (let pass = 0; pass < nodes.length; pass++)
    for (const n of nodes) {
      if (n.dependsOn.every((d) => layers.has(d)))
        layers.set(
          n.id,
          Math.max(0, ...n.dependsOn.map((d) => (layers.get(d) ?? 0) + 1)),
        );
    }
  const counts = new Map<number, number>();
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const layer = layers.get(n.id) ?? 0;
    const row = counts.get(layer) ?? 0;
    counts.set(layer, row + 1);
    pos.set(n.id, { x: 24 + layer * 252, y: 28 + row * 136 });
  }
  const width = (Math.max(0, ...layers.values()) + 1) * 252 + 24,
    height = Math.max(1, ...counts.values()) * 136 + 28;
  return (
    <div
      className="plan-network"
      tabIndex={0}
      aria-label="可横向滚动的任务依赖图"
    >
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="箭头由前置任务指向后续任务，红色节点为依赖关键路径"
      >
        <defs>
          <marker
            id="plan-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#8b9e93" />
          </marker>
        </defs>
        {nodes.flatMap((n) =>
          n.dependsOn.map((d) => {
            const a = pos.get(d),
              b = pos.get(n.id);
            return a && b ? (
              <path
                key={`${d}-${n.id}`}
                d={`M ${a.x + 208} ${a.y + 46} C ${a.x + 230} ${a.y + 46}, ${b.x - 24} ${b.y + 46}, ${b.x} ${b.y + 46}`}
                fill="none"
                stroke="#8b9e93"
                strokeWidth="1.5"
                markerEnd="url(#plan-arrow)"
              />
            ) : null;
          }),
        )}
        {nodes.map((n) => {
          const p = pos.get(n.id)!;
          return (
            <g key={n.id} transform={`translate(${p.x},${p.y})`}>
              <title>
                {n.title}；前置：{n.dependsOn.join("、") || "无"}；
                {modes[n.mode]}；{n.owner}
              </title>
              <rect
                width="208"
                height="96"
                rx="10"
                fill={n.critical && !n.hours ? "#fff6f1" : "#fff"}
                stroke={n.critical && !n.hours ? "#c27859" : "#d3ded5"}
              />
              <text x="12" y="22" fontSize="11" fill="#758579">
                {n.id} · {n.hours ? `${n.hours}—${n.hoursHigh} 小时` : `第 ${n.start+1}—${n.end} 天`}
              </text>
              <text x="12" y="45" fontSize="13" fill="#253731">
                {n.title.length > 13 ? n.title.slice(0, 13) + "…" : n.title}
              </text>
              <text x="12" y="72" fontSize="11" fill="#52725e">
                {modes[n.mode]}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
