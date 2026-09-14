import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  GripVertical,
  ListTodo,
  LogOut,
  Plus,
  Settings2,
  Sparkles,
  X,
  Archive,
  Undo2,
  KeyRound,
} from "lucide-react";
import "./style.css";
import { Planner, type Plan } from "./Planner";
import type { AssistantData } from "./DraftAssistant";
import { goalView } from "./goal-view";
import { normalizePlanInput } from "./plan-input";
import { PBadge, pLevels } from "./p-level";

type Task = {
  pLevel?: string;
  planId?: string;
  nodeId?: string;
  dependencies?: string[];
  id: string;
  title: string;
  notes: string;
  deadline: string;
  zone: string;
  priority: string;
  suggestedPriority: string;
  status: string;
  intent: string;
  created: string;
  reason: string;
  source: string;
};
type Profile = {
  name: string;
  role: string;
  goals: string[];
  rule: string;
  zone: string;
  onboarded: boolean;
};
type State = {
  assistants?: Record<string, AssistantData>;
  deletedPlans?: {plan: Plan}[];
  goalOrder?: string[];
  plans?: Plan[];
  version: number;
  profile: Profile;
  tasks: Task[];
  order: string[];
};
type Suggestion = {
  order: string[];
  priorities: Record<string, string>;
  reasons: Record<string, string>;
  source: string;
  notice: string;
};
type SuggestResult = {
  version: number;
  suggestion: Suggestion;
  applied: boolean;
  state: State;
};
type AIConfigStatus = {
  configured: boolean;
  mode: string;
  model: string;
  verifiedAt: string;
};
const roles = [
  "President",
  "Principal",
  "Teaching manager",
  "SA manager",
  "Teacher",
  "SA",
  "Student",
];
const goals = [
  "教学与考试结果",
  "招生与经营进展",
  "学生服务与支持",
  "长期建设与改进",
  "个人职业发展",
];
const recommended =
  "兼顾教学结果与经营进展；优先处理影响较大、临近截止的事项；保留长期改进任务的位置；尊重我指定的重要程度和顺序。";
const roleGoals: Record<string, string[]> = {
  President: [goals[1], goals[3]],
  Principal: [goals[0], goals[1]],
  "Teaching manager": [goals[0], goals[3]],
  "SA manager": [goals[2], goals[3]],
  Teacher: [goals[0], goals[3]],
  SA: [goals[2], goals[0]],
  Student: [goals[0], goals[4]],
};
const priorityName: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
};
const zone =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
const blank = (tz: string): Task => ({
  id: "",
  title: "",
  notes: "",
  deadline: "",
  zone: tz,
  priority: "",
  suggestedPriority: "",
  status: "open",
  intent: "",
  created: "",
  reason: "",
  source: "",
});
class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch("/api" + path, {
    signal,
    method: body === undefined ? "GET" : method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const v = await r.json();
  if (!r.ok) throw new ApiError(v.error || "请求失败，请重试", r.status);
  return v;
}
import { due } from "./deadline";
function App() {
  const [state, setState] = useState<State | null>(null),
    [loading, setLoading] = useState(true),
    [view, setView] = useState("open"),
    [settings, setSettings] = useState(false),
    [editing, setEditing] = useState<Task | null>(null),
    [preview, setPreview] = useState<{ version: number; s: Suggestion; scope?: string } | null>(
      null,
    ),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [thinking, setThinking] = useState(0),
    [aiConfig, setAiConfig] = useState<AIConfigStatus | null>(null),
    [now, setNow] = useState(Date.now()),
    [query, setQuery] = useState("");
  const live = useRef(state);
  const [openPlan, setOpenPlan] = useState<{id: string; key: number; sourceTaskId?: string}>();
  live.current = state;
  const session = useRef(0);
  useEffect(() => {
    api<State>("/state")
      .then(setState)
      .catch((e) => {
        if (e.status !== 401) setMessage(e.message);
      })
      .finally(() => setLoading(false));
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!state) {
      setAiConfig(null);
      return;
    }
    api<AIConfigStatus>("/ai-config")
      .then(setAiConfig)
      .catch((e) => {
        if (e.status !== 401) setMessage(e.message);
      });
  }, [state?.profile.name]);
  function adopt(s: State) {
    setState((old) => (!old || s.version >= old.version ? s : old));
  }
  async function failure(e: unknown) {
    setMessage(e instanceof Error ? e.message : "操作失败");
    if (e instanceof ApiError && e.status === 409) {
      try {
        adopt(await api<State>("/state"));
      } catch {}
    }
    if (e instanceof ApiError && e.status === 401) {
      session.current++;
      setState(null);
    }
  }
  async function write<T>(
    fn: () => Promise<T>,
    rethrow = false,
  ): Promise<T | undefined> {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        try {
          adopt(await api<State>("/state"));
        } catch {}
      } else {
        await failure(e);
      }
      if (rethrow) throw e;
    } finally {
      setBusy(false);
    }
  }
  async function suggest(s: State, taskId = "", scope = "") {
    const generation = session.current;
    setThinking((n) => n + 1);
    try {
      const r = await api<SuggestResult>("/suggest", {
        version: s.version,
        taskId,
        scope,
      });
      if (generation !== session.current) return;
      if (taskId) {
        if (r.applied) {
          adopt(r.state);
          setMessage(r.suggestion.notice);
        } else {
          setMessage("任务已保存；列表已变化，旧建议没有覆盖你的操作。");
        }
      } else setPreview({ version: r.version, s: r.suggestion, scope });
    } catch (e) {
      if (generation === session.current) await failure(e);
    } finally {
      setThinking((n) => n - 1);
    }
  }
  async function saveTask(t: Task) {
    const generation = session.current;
    const s = live.current;
    if (!s) return false;
    const r = await write(() =>
      api<{ state: State; taskId: string }>(
        "/tasks",
        { version: s.version, task: t },
        t.id ? "PUT" : "POST",
      ),
    );
    if (!r || generation !== session.current) return false;
    adopt(r.state);
    if (!t.id) {
      setOpenPlan({id: "", key: Date.now(), sourceTaskId: r.taskId});
      setView("plans");
      setMessage("大目标已保存，正在自动生成行动路径、初步排期与 P0—P3 优先级……");
      const input = normalizePlanInput({
        goal: {detail: t.title}, current: {detail: t.notes || ""},
        timing: {detail: t.deadline ? `目标截止：${t.deadline}` : ""},
      });
      const planned = await write(() => api<State>("/plans/generate", {
        version: r.state.version, sourceTaskId: r.taskId, input,
      }));
      if (generation !== session.current) return true;
      if (planned) {
        adopt(planned);
        const plan = planned.plans?.find(p => p.sourceTaskId === r.taskId);
        if (plan) {
          setOpenPlan({id: plan.id, key: Date.now()});
          setMessage("行动路径、初步排期与 P0—P3 已生成。请检查草案，六个方向可随时补充。");
        }
      }
    }
    return true;
  }
  async function move(id: string, index: number) {
    const s = live.current;
    if (!s) return;
    const ids = s.order.filter((x) => x !== id);
    ids.splice(Math.max(0, Math.min(index, ids.length)), 0, id);
    await write(async () =>
      adopt(
        await api<State>("/order", { version: s.version, order: ids }, "PUT"),
      ),
    );
  }
  async function logout() {
    await write(async () => {
      await api("/logout", {});
      session.current++;
      setState(null);
      setSettings(false);
      setPreview(null);
      setEditing(null);
      setAiConfig(null);
      setMessage("");
    });
  }
  if (loading)
    return (
      <div className="splash">
        <Brand />
        <p>正在打开你的工作台…</p>
      </div>
    );
  if (!state)
    return (
      <>
        <Auth
          onLogin={(s) => {
            session.current++;
            setState(s);
            setMessage("");
          }}
          onError={setMessage}
        />
        {message && <Toast text={message} close={() => setMessage("")} />}
      </>
    );
  const all = state.order
    .map((id) => state.tasks.find((t) => t.id === id)!)
    .filter(Boolean);
  const goals = goalView(state.plans || [], state.tasks);
  goals.groups.sort((a, b) => {
    const position = (g: typeof a) => {
      const saved = state.goalOrder?.indexOf(g.plan.id) ?? -1;
      if (saved >= 0) return saved - (state.goalOrder?.length || 0);
      const ids = new Set([g.source?.id, ...g.children.map(t => t.id)]);
      const index = state.order.findIndex(id => ids.has(id));
      return index < 0 ? state.order.length : index;
    };
    return position(a) - position(b);
  });
  const groups = goals.groups.filter(g => [g.plan.title, g.source?.title, ...g.children.map(t => t.title)].some(t => t?.toLowerCase().includes(query.toLowerCase())));
  const projectCandidates = goals.groups.length + goals.standalone.length;
  const visibleCount = projectCandidates;
  const actionable = [...goals.standalone, ...goals.groups.flatMap(g => g.ready)];
  const tasks = (
    view === "open"
      ? all.filter(t => goals.standalone.some(x => x.id === t.id))
      : state.tasks
          .filter((t) => t.status !== "open")
          .slice()
          .reverse()
  ).filter((t) => t.title.toLowerCase().includes(query.toLowerCase())).sort((a, b) => {
    if (view !== "open") return 0;
    const position = (id: string) => {
      const saved = state.goalOrder?.indexOf(id) ?? -1;
      return saved >= 0 ? saved : state.order.indexOf(id) + (state.goalOrder?.length || 0);
    };
    return position(a.id) - position(b.id);
  });
  const projectItems = [
    ...groups.map(g => ({ kind: "plan" as const, id: g.plan.id, group: g })),
    ...tasks.map(t => ({ kind: "task" as const, id: t.id, task: t })),
  ].sort((a, b) => {
    const position = (id: string) => {
      const saved = state.goalOrder?.indexOf(id) ?? -1;
      return saved >= 0 ? saved : state.order.indexOf(id) + (state.goalOrder?.length || 0);
    };
    return position(a.id) - position(b.id);
  });
  const overdue = actionable.filter((t) => due(t, now) === "overdue").length,
    soon = actionable.filter((t) => due(t, now) === "soon").length;
  return (
    <div className="shell">
      <aside>
        <Brand />
        <div className="workspace-label">PERSONAL WORKSPACE</div>
        <button
          className={"nav " + (view === "open" ? "selected" : "")}
          onClick={() => setView("open")}
        >
          <ListTodo size={19} />
          我的待办<span>{visibleCount}</span>
        </button>
        <button className={"nav " + (view === "plans" ? "selected" : "")} onClick={() => setView("plans")}>
          <Sparkles size={19} />目标计划<span>v0.3</span>
        </button>
        <button
          className={"nav " + (view === "archive" ? "selected" : "")}
          onClick={() => setView("archive")}
        >
          <Archive size={19} />
          已归档<span>{state.tasks.length - all.length}</span>
        </button>
        <button className="nav settings-nav" onClick={() => setSettings(true)}>
          <Settings2 size={18} />
          我的优先规则
        </button>
        <button
          className={"nav api-nav " + (view === "api" ? "selected" : "")}
          onClick={() => setView("api")}
        >
          <KeyRound size={18} />
          AI API 配置
          {aiConfig?.configured && <i className="configured-dot" />}
        </button>
        <div className="side-note">
          <span className="small-orbit">↗</span>
          <h3>把注意力留给重要的事</h3>
          <p>
            AI 提供建议，
            <br />
            决定权始终在你。
          </p>
        </div>
        <div className="user">
          <div className="avatar">{state.profile.name.slice(0, 1)}</div>
          <div>
            <strong>{state.profile.name}</strong>
            <small>{state.profile.role}</small>
          </div>
          <button
            className="icon"
            aria-label="退出登录"
            title="退出登录"
            onClick={logout}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            我的工作空间 <ChevronRight size={14} />{" "}
            {view === "open"
              ? "行动列表"
              : view === "api"
                ? "AI API 配置"
                : view === "plans" ? "目标计划" : "归档记录"}
          </span>
          <span
            className={"connection " + (aiConfig?.configured ? "ready" : "")}
          >
            <i />
            {aiConfig?.configured ? "MiMo 已连接" : "基础规则模式"}
          </span>
        </header>
        <div className="content">
          <div className="heading">
            <div>
              <p className="eyebrow">
                {new Intl.DateTimeFormat("zh-CN", {
                  timeZone: state.profile.zone,
                  month: "long",
                  day: "numeric",
                  weekday: "long",
                }).format(new Date(now))}
              </p>
              <h1>
                {view === "open"
                  ? "下一步，更清晰。"
                  : view === "api"
                    ? "让 AI 接手排序，其他交给我。"
                    : view === "plans" ? "大目标，从这里开始。" : "每一步，都有记录。"}
              </h1>
              <p className="subtitle">
                {view === "open"
                  ? "从一件小事开始，按你的节奏推进重要的工作。"
                  : view === "api"
                    ? "粘贴一次 MiMo API Key，之后 ATriage 会自动判断接入方式。"
                    : view === "plans" ? "梳理行动路径，安排投入，把握需要你介入的节点。" : "完成与决定不做分别保存，随时可以恢复。"}
              </p>
            </div>
            <span className="edition">ATriage / v0.3</span>
          </div>
          {view !== "api" && view !== "plans" && (
            <>
              <div className="stats">
                <div>
                  <span>待推进</span>
                  <b>{visibleCount.toString().padStart(2, "0")}</b>
                  <small>按你的顺序</small>
                </div>
                <div>
                  <span>即将到期</span>
                  <b>{soon.toString().padStart(2, "0")}</b>
                  <small>未来 24 小时</small>
                </div>
                <div className={overdue ? "alert-stat" : ""}>
                  <span>已逾期</span>
                  <b>{overdue.toString().padStart(2, "0")}</b>
                  <small>值得重新安排</small>
                </div>
              </div>
              <button
                className="policy-banner"
                onClick={() => setSettings(true)}
              >
                <div className="policy-icon">
                  <Settings2 size={20} />
                </div>
                <div>
                  <strong>
                    你的优先规则 <span>{state.profile.role}</span>
                  </strong>
                  <p>{state.profile.rule}</p>
                </div>
                <ChevronRight size={18} />
              </button>
            </>
          )}
          {view === "api" && (
            <ApiConfigPage
              config={aiConfig}
              busy={busy}
              save={async (apiKey) => {
                const result = await write(() =>
                  api<AIConfigStatus>("/ai-config", { apiKey }, "PUT"),
                );
                if (result) {
                  setAiConfig(result);
                  setMessage(
                    "MiMo 已验证并保存。之后创建任务时会自动使用 AI 建议。",
                  );
                  return true;
                }
                return false;
              }}
            />
          )}
          {view === "open" && (
            <TaskComposer
              zone={state.profile.zone}
              busy={busy}
              save={saveTask}
            />
          )}
          <div hidden={view !== "plans"}>
            <Planner assistants={state.assistants || {}} version={state.version} deletedPlans={state.deletedPlans || []} editTask={id => {const t = state.tasks.find(t => t.id === id); if (t) setEditing({...t});}} openRequest={openPlan} plans={state.plans || []} tasks={state.tasks} busy={busy} configured={!!aiConfig?.configured} configure={() => setView("api")} run={async (path, body, method, signal) => {
              const generation = session.current;
              const result = await write(async () => {
                const latest = await api<State>("/state", undefined, "POST", signal);
                live.current = latest;
                adopt(latest);
                const next = await api<State>(path, { ...(body as object), version: latest.version }, method, signal);
                live.current = next;
                adopt(next);
                if (path === "/assistant/chat" && (body as { autoApply?: boolean }).autoApply) {
                  const planId = (body as { planId: string }).planId;
                  const proposal = next.assistants?.[planId]?.proposal;
                  if (proposal && !next.assistants?.[planId]?.error && next.plans?.find(p => p.id === planId)?.status === "draft" && !signal?.aborted) {
                    const applied = await api<State>("/assistant/apply", { version: next.version, planId, proposalId: proposal.id }, "POST", signal);
                    live.current = applied;
                    return applied;
                  }
                }
                return next;
              }, true);
              if (result && generation === session.current) { adopt(result); return result.plans || []; }
            }} />
          </div>
          {view !== "api" && view !== "plans" && (
            <>
              <div className="list-toolbar">
                <div>
                  <h2>{view === "open" ? "行动清单" : "归档记录"}</h2>
                  <span>
                    {tasks.length + (view === "open" ? groups.length : 0)} 项{thinking > 0 ? " · 正在获取建议…" : ""}
                  </span>
                </div>
                <div className="tools">
                  <input
                    aria-label="搜索任务"
                    placeholder="搜索任务…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {view === "open" && (
                    <button
                      className="secondary"
                      disabled={busy || thinking > 0 || !projectCandidates}
                      onClick={() => suggest(state, "", "goals")}
                    >
                      <Sparkles size={15} />
                      AI 重排大项目
                    </button>
                  )}
                </div>
              </div>
              {view === "open" && (
                <div className="list-caption">
                  <span>{goals.groups.length ? "目标 / 当前可执行行动" : "顺序 / 任务"}</span>
                  <span>{goals.groups.length ? "行动截止日" : "重要程度与截止状态"}</span>
                </div>
              )}
              <div className="task-list">
                {view === "open" && projectItems.map(item => item.kind === "plan" ? (() => {
                  const g = item.group;
                  return <section className="goal-action-card" key={g.plan.id}>
                    <header>
                      <button className="goal-link" onClick={() => {setOpenPlan({id: g.plan.id, key: Date.now()}); setView("plans");}}>
                        <strong>{g.source?.title || g.plan.title}</strong><span>查看目标计划 ↗</span>
                      </button>
                      <small>{g.plan.status === "draft" ? "草案 · 确认后开始执行" : `已完成 ${g.done} / ${g.children.length}`}{g.source?.deadline ? ` · 目标截止 ${g.source.deadline.replace("T", " ")}` : ""}</small>
                    </header>
                    <div className="goal-next-label">当前下一步{g.ready.length > 1 || g.preview.length > 1 ? " · 可并行推进" : ""}</div>
                    {g.ready.map(t => <div className="goal-next-action" key={t.id}>
                      <button className="icon" aria-label={`完成 ${t.title}`} disabled={busy} onClick={() => saveTask({...t, status: "done"})}><Circle size={19}/></button>
                      <button className="goal-action-title" onClick={() => setEditing({...t})}>{t.nodeId} · {t.title} <PBadge level={t.pLevel}/></button>
                      <button className={"goal-action-date " + due(t, now)} onClick={() => setEditing({...t})}>{t.deadline ? `截止 ${t.deadline.replace("T", " ")}` : "设置行动截止日"}</button>
                    </div>)}
                    {g.preview.map(n => <div className="goal-next-action" key={n.id}><span>{n.id} · {n.title} <PBadge level={n.pLevel}/></span><small>待确认 · 截止日未设置</small></div>)}
                    {!g.ready.length && !g.preview.length && <p>{g.done === g.children.length && g.children.length ? "执行项已全部完成。" : "暂无可执行行动，请在计划中检查前置任务（跳过不等于完成）。"}</p>}
                  </section>;
                })() : (
                  <TaskRow
                    key={item.task.id}
                    remove={async () => {
                      const result = await write(() => api<State>("/plans/delete", {version: live.current!.version, planId: item.task.id}));
                      if (result) { adopt(result); setMessage("大目标已移入回收站，可在目标计划页面恢复。"); }
                    }}
                    task={item.task}
                    blocked={(item.task.dependencies || []).filter(id => state.tasks.find(x => x.id === id)?.status !== "done").map(id => state.tasks.find(x => x.id === id)?.title || "前置任务")}
                    rank={projectItems.findIndex(x => x.id === item.id) + 1}
                    total={projectItems.length}
                    now={now}
                    busy={busy}
                    move={move}
                    edit={() => setEditing({ ...item.task })}
                    save={saveTask}
                  />
                ))}
                {view !== "open" && tasks.map((t) => (
                  <TaskRow key={t.id} task={t} blocked={(t.dependencies || []).filter(id => state.tasks.find(x => x.id === id)?.status !== "done").map(id => state.tasks.find(x => x.id === id)?.title || "前置任务")} rank={state.order.indexOf(t.id) + 1} total={all.length} now={now} busy={busy} move={move} edit={() => setEditing({ ...t })} save={saveTask} />
                ))}
                {!tasks.length && !(view === "open" && groups.length) && (
                  <div className="empty">
                    <div>
                      <ListTodo size={30} />
                    </div>
                    <h3>
                      {query
                        ? "没有找到匹配任务"
                        : view === "open"
                          ? "给下一步一个位置"
                          : "还没有归档记录"}
                    </h3>
                    <p>
                      {view === "open"
                        ? "写下一句话就能开始，其他信息可以稍后补充。"
                        : "已完成和决定不做的任务会出现在这里。"}
                    </p>
                  </div>
                )}
              </div>
              <footer>
                <span>
                  <span className="dot" />
                  人工顺序始终受到保护
                </span>
                <span>时间按 {state.profile.zone} 显示 · 仅提供截止提醒</span>
              </footer>
            </>
          )}
        </div>
      </main>
      {(settings || !state.profile.onboarded) && (
        <Settings
          profile={state.profile}
          required={!state.profile.onboarded}
          close={() => setSettings(false)}
          busy={busy}
          save={async (p) => {
            const result = await write(() =>
              api<State>(
                "/profile",
                { version: live.current!.version, profile: p },
                "PUT",
              ),
            );
            if (result) {
              adopt(result);
              setSettings(false);
              setMessage(
                "规则已保存：后续建议将参考你的规则，现有顺序保持不变。",
              );
            }
          }}
        />
      )}
      {editing && (
        <Modal title="编辑任务" close={() => setEditing(null)}>
          <TaskFields task={editing} change={setEditing} />
          <div className="modal-actions">
            <button className="secondary" onClick={() => setEditing(null)}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                if (await saveTask(editing)) setEditing(null);
              }}
            >
              保存修改
            </button>
          </div>
        </Modal>
      )}
      {preview && (
        <Modal title="建议顺序，供你决定" close={() => setPreview(null)}>
          <div className="notice">
            <Sparkles size={18} />
            {preview.s.notice}
          </div>
          <p className="muted">{preview.scope === "goals" ? "会预排目标计划和未拆解的顶层任务；没有截止日的项目也会参考你的规则参与排序。项目内的小任务、依赖与截止日保持不变。" : "以下是预览。应用之前，实际列表不会改变。"}</p>
          <div className="preview-list">
            {preview.s.order.map((id, i) => {
              const t = preview.scope === "goals" ? state.plans?.find(p => p.id === id) || state.tasks.find(t => t.id === id) : state.tasks.find((t) => t.id === id);
              return (
                t && (
                  <article key={id}>
                    <b>{i + 1}</b>
                    <div>
                      <strong>{t.title}</strong>
                      <p>{preview.s.reasons[id]}</p>
                    </div>
                  </article>
                )
              );
            })}
          </div>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setPreview(null)}>
              保留原顺序
            </button>
            <button
              className="primary"
              disabled={busy || preview.version !== state.version}
              onClick={async () => {
                const s = await write(() =>
                  api<State>(
                    "/order",
                    { version: preview.version, order: preview.s.order, scope: preview.scope },
                    "PUT",
                  ),
                );
                if (s) {
                  adopt(s);
                  setPreview(null);
                  setMessage("已应用你确认的顺序；人工重要程度未改变。");
                }
              }}
            >
              应用建议顺序
            </button>
          </div>
          {preview.version !== state.version && (
            <p className="warning">
              列表已变化，这份建议已过期。请关闭后重新获取。
            </p>
          )}
        </Modal>
      )}
      {message && <Toast text={message} close={() => setMessage("")} />}
    </div>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span>↗</span>
      <strong>
        ATriage<small>MAKE ROOM FOR WHAT MATTERS</small>
      </strong>
    </div>
  );
}
function ApiConfigPage({
  config,
  busy,
  save,
}: {
  config: AIConfigStatus | null;
  busy: boolean;
  save: (key: string) => Promise<boolean>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  return (
    <section className="api-page">
      <div className="api-hero">
        <div className="api-emblem">
          <KeyRound size={27} />
        </div>
        <div>
          <p className="eyebrow">MIMO CONNECT</p>
          <h2>只需要粘贴你的 API Key。</h2>
          <p>
            ATriage 会自动识别你使用的是 MiMo Token Plan
            还是按量付费，并选用适合的官方接口和模型。
          </p>
        </div>
      </div>
      <form
        className="api-card"
        onSubmit={async (event) => {
          event.preventDefault();
          if (await save(apiKey)) {
            setApiKey("");
            setShowKey(false);
          }
        }}
      >
        <label>
          MiMo API Key
          <div className="key-input">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
              spellCheck="false"
              required
              placeholder="粘贴以 sk- 或 tp- 开头的 API Key"
            />
            <button
              type="button"
              className="text-button"
              onClick={() => setShowKey(!showKey)}
            >
              {showKey ? "隐藏" : "显示"}
            </button>
          </div>
        </label>
        <p className="field-hint">
          Key 只发送给这台电脑上的 ATriage
          服务进行验证和调用；浏览器不会再显示或保存它。
        </p>
        <button className="primary" disabled={busy || !apiKey.trim()}>
          {busy
            ? "正在验证 MiMo…"
            : config?.configured
              ? "替换并验证 Key"
              : "保存并连接 MiMo"}
          <ArrowUpRight size={17} />
        </button>
      </form>
      <div
        className={"connection-card " + (config?.configured ? "connected" : "")}
      >
        <div>
          <span className="connection-icon">
            {config?.configured ? <Check size={19} /> : <Circle size={19} />}
          </span>
          <div>
            <strong>
              {config?.configured ? "MiMo 已连接" : "尚未连接 MiMo"}
            </strong>
            <p>
              {config?.configured
                ? `已验证 · ${config.mode} · ${config.model}`
                : "未配置时仍可使用基础规则排序，任务不会受影响。"}
            </p>
          </div>
        </div>
        {config?.configured && (
          <small>
            验证时间：
            {new Intl.DateTimeFormat("zh-CN", {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(config.verifiedAt))}
          </small>
        )}
      </div>
      <div className="api-explainer">
        <article>
          <b>1</b>
          <div>
            <h3>复制 Key</h3>
            <p>在 MiMo 控制台创建或复制 API Key。</p>
          </div>
        </article>
        <article>
          <b>2</b>
          <div>
            <h3>粘贴并保存</h3>
            <p>无需填写 URL、模型名或其他参数。</p>
          </div>
        </article>
        <article>
          <b>3</b>
          <div>
            <h3>自动使用</h3>
            <p>以后创建任务，ATriage 自动请求建议；你的人工排序仍受保护。</p>
          </div>
        </article>
      </div>
      <p className="api-note">
        按量付费 Key 通常以 <code>sk-</code> 开头。Token Plan Key 通常以{" "}
        <code>tp-</code> 开头，ATriage 会自动识别可用官方节点。API Key
        会以本机加密形式保存；若更换 Key，直接在这里重新粘贴即可。
      </p>
    </section>
  );
}
function Toast({ text, close }: { text: string; close: () => void }) {
  return (
    <div className="toast" role="status">
      <span>{text}</span>
      <button className="icon" aria-label="关闭提示" onClick={close}>
        <X size={16} />
      </button>
    </div>
  );
}
function Auth({
  onLogin,
  onError,
}: {
  onLogin: (s: State) => void;
  onError: (s: string) => void;
}) {
  const [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false);
  return (
    <div className="auth">
      <section className="auth-story">
        <Brand />
        <div>
          <p className="eyebrow">LESS NOISE. MORE INTENTION.</p>
          <h1>
            事情很多。
            <br />
            下一步，<em>可以很清晰。</em>
          </h1>
          <p>
            让每一件工作找到合适的位置。
            <br />
            你的目标、你的规则、你的决定。
          </p>
          <div className="sample">
            <span>YOUR NEXT MOVE</span>
            <div>
              <b>01</b> 把重要的工作向前推进 <Check size={18} />
            </div>
            <div>
              <b>02</b> 为长期目标留一点空间
            </div>
            <div>
              <b>03</b> 按自己的节奏调整
            </div>
          </div>
        </div>
        <small>ATriage v0.3 · 为有判断力的人提供行动建议</small>
      </section>
      <section className="auth-form">
        <div>
          <p className="eyebrow">YOUR PERSONAL WORKSPACE</p>
          <h2>{register ? "创建你的工作空间" : "欢迎回来"}</h2>
          <p className="muted">
            {register ? "从你的优先规则开始。" : "登录，继续推进重要的事。"}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const data = new FormData(e.currentTarget);
              try {
                onLogin(
                  await api<State>(register ? "/register" : "/login", {
                    email: data.get("email"),
                    password: data.get("password"),
                    name: data.get("name") || "",
                    zone,
                  }),
                );
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {register && (
              <label>
                怎么称呼你
                <input
                  name="name"
                  required
                  maxLength={60}
                  autoComplete="name"
                  placeholder="你的称呼"
                />
              </label>
            )}
            <label>
              邮箱
              <input
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
              />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                required
                minLength={8}
                maxLength={72}
                autoComplete={register ? "new-password" : "current-password"}
                placeholder="至少 8 位"
              />
            </label>
            <button className="primary wide" disabled={busy}>
              {busy ? "请稍候…" : register ? "创建账号" : "进入工作空间"}
              <ArrowUpRight size={18} />
            </button>
          </form>
          <p className="switch-auth">
            {register ? "已有账号？" : "第一次使用？"}
            <button onClick={() => setRegister(!register)}>
              {register ? "登录" : "创建账号"}
            </button>
          </p>
          <p className="auth-footnote">
            个人任务独立保存 · 人工选择优先
            <br />
            本地首版暂不支持邮件验证与密码找回，请妥善保存密码。
          </p>
        </div>
      </section>
    </div>
  );
}
function Modal({
  title,
  close,
  children,
  dismissible = true,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    const el = ref.current;
    const nodes = () =>
      Array.from(
        el?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,textarea,select,[tabindex="0"]',
        ) || [],
      );
    nodes()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) {
        e.preventDefault();
        close();
      }
      if (e.key === "Tab") {
        const n = nodes();
        const i = n.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          n.at(-1)?.focus();
        } else if (!e.shiftKey && i === n.length - 1) {
          e.preventDefault();
          n[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      old?.focus();
    };
  }, []);
  return (
    <div className="overlay">
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          {dismissible && (
            <button className="icon" aria-label="关闭窗口" onClick={close}>
              <X size={20} />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
function Settings({
  profile,
  required,
  close,
  save,
  busy,
}: {
  profile: Profile;
  required: boolean;
  close: () => void;
  save: (p: Profile) => void;
  busy: boolean;
}) {
  const [p, setP] = useState({ ...profile }),
    [custom, setCustom] = useState(!roles.includes(profile.role)),
    [focusInput, setFocusInput] = useState(""),
    [focusError, setFocusError] = useState("");
  function changeGoals(g: string[]) {
    setP({
      ...p,
      goals: g,
      rule: g.length
        ? `优先考虑：${g.join("，其次是")}。在以上目标下兼顾截止时间与长期价值；尊重我指定的重要程度和顺序。`
      : recommended,
    });
  }
  function addFocus() {
    const focus = focusInput.trim().replace(/\s+/g, " ");
    if (!focus) {
      setFocusError("请先写下一个关注点。");
      return;
    }
    if ([...focus].length > 80) {
      setFocusError("关注点最多 80 个字。");
      return;
    }
    if (p.goals.includes(focus)) {
      setFocusError("这个关注点已经在你的优先顺序中。");
      return;
    }
    if (p.goals.length >= 10) {
      setFocusError("最多可保留 10 个关注点，请先取消一个再添加。");
      return;
    }
    changeGoals([...p.goals, focus]);
    setFocusInput("");
    setFocusError("");
  }
  return (
    <Modal
      title={required ? "先告诉我们，什么对你更重要" : "我的优先规则"}
      close={required ? () => {} : close}
      dismissible={!required}
    >
      <p className="muted">角色只是起点，你可以按自己的想法修改全部规则。</p>
      <div className="form-grid">
        <label>
          称呼
          <input
            value={p.name}
            maxLength={60}
            onChange={(e) => setP({ ...p, name: e.target.value })}
          />
        </label>
        <label>
          角色
          <select
            value={custom ? "custom" : p.role}
            onChange={(e) => {
              const v = e.target.value;
              setCustom(v === "custom");
              if (v === "custom") setP({ ...p, role: "" });
              else {
                const g = roleGoals[v] || [];
                setP({
                  ...p,
                  role: v,
                  goals: g,
                  rule: `优先考虑：${g.join("，其次是")}。兼顾截止时间与长期价值；尊重我指定的重要程度和顺序。`,
                });
              }
            }}
          >
            {roles.map((r) => (
              <option key={r}>{r}</option>
            ))}
            <option value="custom">自定义角色</option>
          </select>
        </label>
      </div>
      {custom && (
        <label>
          你的角色
          <input
            value={p.role}
            maxLength={80}
            onChange={(e) => setP({ ...p, role: e.target.value })}
          />
        </label>
      )}
      <label>
        我更关注什么 <small>选中后，用箭头调整先后</small>
      </label>
      <div className="goals">
        {[...p.goals, ...goals.filter((g) => !p.goals.includes(g))].map((g) => {
          const idx = p.goals.indexOf(g);
          const isCustomFocus = !goals.includes(g);
          return (
            <div key={g} className={idx >= 0 ? "chosen" : ""}>
              <label>
                <input
                  type="checkbox"
                  checked={idx >= 0}
                  onChange={() =>
                    changeGoals(
                      idx >= 0
                        ? p.goals.filter((x) => x !== g)
                        : [...p.goals, g],
                    )
                  }
                />
                {idx >= 0 && <b>{idx + 1}.</b>}
                {g}
                {isCustomFocus && <em className="custom-goal-tag">自定义</em>}
              </label>
              {idx >= 0 && (
                <span>
                  <button
                    className="icon"
                    aria-label={`${g}上移`}
                    disabled={idx === 0}
                    onClick={() => {
                      const a = [...p.goals];
                      [a[idx - 1], a[idx]] = [a[idx], a[idx - 1]];
                      changeGoals(a);
                    }}
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    className="icon"
                    aria-label={`${g}下移`}
                    disabled={idx === p.goals.length - 1}
                    onClick={() => {
                      const a = [...p.goals];
                      [a[idx + 1], a[idx]] = [a[idx], a[idx + 1]];
                      changeGoals(a);
                    }}
                  >
                    <ArrowDown size={15} />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="custom-goal-entry">
        <input
          aria-label="手动添加关注点"
          value={focusInput}
          maxLength={80}
          placeholder="手动添加，例如：提高家长满意度"
          onChange={(e) => {
            setFocusInput(e.target.value);
            if (focusError) setFocusError("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addFocus();
            }
          }}
        />
        <button type="button" className="secondary" onClick={addFocus}>
          添加关注点
        </button>
      </div>
      {focusError && <p className="input-error" role="alert">{focusError}</p>}
      <p className="field-hint">添加后会排在最后，可用箭头调整优先级，并同步写入规则草稿。</p>
      <button className="text-button" onClick={() => changeGoals([])}>
        没有明确想法，使用推荐规则
      </button>
      <label>
        我的规则 <small>可自由编辑；改变上方选项会重新生成文本</small>
        <textarea
          rows={4}
          maxLength={4000}
          value={p.rule}
          onChange={(e) => setP({ ...p, rule: e.target.value })}
        />
      </label>
      <div className="rule-summary">
        <strong>规则摘要</strong>
        <p>
          {p.rule.length > 160
            ? p.rule.slice(0, 160) + "…"
            : p.rule || "请填写你希望遵循的规则。"}
        </p>
        <small>
          保留你的原话。AI 排序时会参考完整文本，现有人工顺序不自动改变。
        </small>
      </div>
      <label>
        默认时区
        <input
          list="zones"
          value={p.zone}
          onChange={(e) => setP({ ...p, zone: e.target.value })}
        />
        <datalist id="zones">
          {[
            "Asia/Shanghai",
            "Asia/Hong_Kong",
            "Asia/Singapore",
            "Asia/Tokyo",
            "Europe/London",
            "America/New_York",
            "America/Los_Angeles",
            "UTC",
          ].map((z) => (
            <option key={z}>{z}</option>
          ))}
        </datalist>
        <small>已创建任务保留各自的截止时区。</small>
      </label>
      <div className="modal-actions">
        {!required && (
          <button className="secondary" onClick={close}>
            取消
          </button>
        )}
        <button
          className="primary"
          disabled={busy || !p.name.trim() || !p.role.trim() || !p.rule.trim()}
          onClick={() => save({ ...p, onboarded: true })}
        >
          {required ? "开始安排我的工作" : "保存规则"}
        </button>
      </div>
    </Modal>
  );
}
function TaskFields({
  task: t,
  change,
}: {
  task: Task;
  change: (t: Task) => void;
}) {
  const date = t.deadline.slice(0, 10),
    tm = t.deadline.slice(11, 16);
  return (
    <>
      <label>
        任务描述
        <input
          required
          maxLength={300}
          value={t.title}
          onChange={(e) => change({ ...t, title: e.target.value })}
          placeholder="例如：和教学主管确认期末复习安排"
        />
      </label>
      <div className="form-grid">
        <label>
          截止日期 · 可选
          <input
            aria-label="截止日期"
            type="date"
            value={date}
            onChange={(e) =>
              change({
                ...t,
                deadline: e.target.value
                  ? e.target.value + (tm ? "T" + tm : "")
                  : "",
              })
            }
          />
        </label>
        <label>
          截止时间 · 可选
          <input
            aria-label="截止时间"
            type="time"
            disabled={!date}
            value={tm}
            onChange={(e) =>
              change({
                ...t,
                deadline: date + (e.target.value ? "T" + e.target.value : ""),
              })
            }
          />
        </label>
      </div>
      <p className="field-hint">仅选日期时，按当天结束计算。时区：{t.zone}</p>
      {t.planId && <label>执行优先级<select value={t.pLevel || ""} onChange={e => change({...t, pLevel: e.target.value})}><option value="">待评定</option>{Object.entries(pLevels).map(([level, description]) => <option key={level} value={level}>{level} · {description}</option>)}</select><small>P级与委派方式独立；P0也可由他人执行。</small></label>}
      <label>
        重要程度
        <select
          value={t.priority}
          onChange={(e) => change({ ...t, priority: e.target.value })}
        >
          <option value="">AI 建议</option>
          <option value="high">高 · 优先关注</option>
          <option value="medium">中 · 稳步推进</option>
          <option value="low">低 · 灵活安排</option>
        </select>
      </label>
      <label>
        补充说明 · 可选
        <textarea
          rows={2}
          maxLength={3000}
          value={t.notes}
          onChange={(e) => change({ ...t, notes: e.target.value })}
          placeholder="有关目标、背景或需要注意的事…"
        />
      </label>
    </>
  );
}
function TaskComposer({
  zone,
  busy,
  save,
}: {
  zone: string;
  busy: boolean;
  save: (t: Task) => Promise<boolean>;
}) {
  const [t, setT] = useState(blank(zone)),
    [more, setMore] = useState(false);
  useEffect(() => setT((x) => ({ ...x, zone })), [zone]);
  return (
    <form
      className="composer"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await save(t)) {
          setT(blank(zone));
          setMore(false);
        }
      }}
    >
      <div className="quick-add">
        <Plus size={21} />
        <input
          aria-label="新任务描述"
          placeholder="有什么需要推进？写下一件事…"
          maxLength={300}
          required
          value={t.title}
          onChange={(e) => setT({ ...t, title: e.target.value })}
        />
        <button className="primary" disabled={busy || !t.title.trim()}>
          添加大目标
          <ArrowUpRight size={16} />
        </button>
      </div>
      <div className="composer-bottom">
        <button
          type="button"
          className="text-button"
          onClick={() => setMore(!more)}
        >
          <ChevronDown size={14} />{" "}
          {more ? "收起选项" : "截止时间、重要程度与更多选项"}
        </button>
        <span>一句话就够，细节可以稍后补充</span>
      </div>
      {more && (
        <div className="composer-fields">
          <TaskFields task={t} change={setT} />
        </div>
      )}
    </form>
  );
}
function TaskRow({
  remove,
  task: t,
  blocked,
  rank,
  total,
  now,
  busy,
  move,
  edit,
  save,
}: {
  remove?: () => void;
  task: Task;
  blocked: string[];
  rank: number;
  total: number;
  now: number;
  busy: boolean;
  move: (id: string, i: number) => void;
  edit: () => void;
  save: (t: Task) => Promise<boolean>;
}) {
  const [expanded, setExpanded] = useState(false),
    [position, setPosition] = useState(String(rank));
  useEffect(() => setPosition(String(rank)), [rank]);
  const d = due(t, now),
    p = t.priority || t.suggestedPriority || "medium";
  return (
    <article
      className={"task " + (d === "overdue" ? "late" : "")}
      onDragOver={(e) => {
        if (t.status === "open") e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData("text/atriage-task");
        if (id && !busy) move(id, rank - 1);
      }}
    >
      <div className="task-main">
        {t.status === "open" ? (
          <>
            <span
              className="drag"
              draggable={!busy}
              onDragStart={(e) =>
                e.dataTransfer.setData("text/atriage-task", t.id)
              }
              title="拖动调整顺序"
            >
              <GripVertical size={16} />
            </span>
            <input
              className="rank"
              aria-label={`${t.title}的排名`}
              type="number"
              min={1}
              max={total}
              value={position}
              disabled={busy}
              onChange={(e) => setPosition(e.target.value)}
              onBlur={() => {
                const n = Number(position);
                if (Number.isInteger(n) && n >= 1 && n <= total && n !== rank)
                  move(t.id, n - 1);
                else setPosition(String(rank));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            <button
              className="complete icon"
              disabled={busy || blocked.length > 0}
              title={blocked.length ? "等待：" + blocked.join("、") : "完成任务"}
              aria-label={`完成${t.title}`}
              onClick={() => save({ ...t, status: "done" })}
            >
              <Circle size={21} />
            </button>
          </>
        ) : (
          <span className={"archive-mark " + t.status}>
            {t.status === "done" ? <Check size={20} /> : <Archive size={20} />}
          </span>
        )}
        <button className="task-title" onClick={() => setExpanded(!expanded)}>
          <strong>{t.title}</strong>
          {t.status === "open" && blocked.length > 0 && <small className="warning">等待前置任务：{blocked.join("、")}</small>}
          <span>
            {t.status === "done"
              ? "已完成"
              : t.status === "skipped"
                ? "决定不做"
                : t.intent === "human"
                  ? "考虑请他人协助 · 尚未委派"
                  : t.intent === "ai"
                    ? "考虑用 AI 协助 · 尚未执行"
                    : t.priority
                      ? "由你指定重要程度"
                      : t.source === "ai"
                        ? "AI 建议"
                        : "基础规则建议"}
          </span>
        </button>
        <div className="task-meta">
          <span className={"priority " + p}>
            {priorityName[p]}
            <small>{t.priority ? " · 人工" : ""}</small>
          </span>
          {t.deadline && (
            <span className={"deadline " + d}>
              <Clock3 size={13} />
              {d === "overdue"
                ? "已逾期 · "
                : d === "soon"
                  ? "即将到期 · "
                  : ""}
              {t.deadline.replace("T", " ")}
            </span>
          )}
        </div>
        <button
          className="icon"
          aria-label={`展开${t.title}`}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
      </div>
      {expanded && (
        <div className="task-detail">
          <p>
            <Sparkles size={14} />
            {t.reason || "暂无建议。"}
          </p>
          {t.notes && <p className="notes">{t.notes}</p>}
          {t.deadline && (
            <small>
              截止时区：{t.zone}。
              {t.deadline.length === 10 ? "按当日结束计算。" : ""}
            </small>
          )}
          {d && p === "low" && (
            <div className="risk">
              <strong>重要程度低，但截止时间需要留意。</strong>
              <p>
                可以按自己的意愿调整顺序、改期、考虑他人或 AI
                协助，或者决定不做。
              </p>
            </div>
          )}
          <div className="task-actions">
            {t.status === "open" ? (
              <>
                <button disabled={busy} onClick={edit}>
                  编辑 / 改期
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    save({ ...t, intent: t.intent === "human" ? "" : "human" })
                  }
                >
                  考虑他人协助
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    save({ ...t, intent: t.intent === "ai" ? "" : "ai" })
                  }
                >
                  考虑 AI 协助
                </button>
                <button
                  disabled={busy}
                  onClick={() => save({ ...t, status: "skipped" })}
                >
                  决定不做
                </button>
                {remove && <button disabled={busy} onClick={remove}>删除大目标（移入回收站）</button>}
              </>
            ) : (
              <button
                disabled={busy}
                onClick={() => save({ ...t, status: "open" })}
              >
                <Undo2 size={14} />
                恢复到待办末尾
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
