import { useEffect, useState, useRef } from "react";
import type { Plan, PlanNode } from "./Planner";
import "./draft-assistant.css";
import { hourSchedule } from "./hour-schedule";

type Message = { id: string; role: string; text: string; created: string };
type Part = { id: string; location: string; text: string };
type Source = {
  id: string;
  name: string;
  url?: string;
  original?: string;
  parts: Part[];
};
type Row = {
  topic: string;
  status: string;
  hours: number;
  hoursHigh: number;
  basis: string;
  refs: string[];
  nodeIds: string[];
};
export type AssistantData = {
  messages?: Message[];
  memory?: { kind: string; text: string; evidence: string[] }[];
  compacted: number;
  compactions: number;
  contextBytes: number;
  readRefs?: string[];
  sources?: Source[];
  constraints: string;
  weeklyHours: number;
  locked?: string[];
  analysis?: Row[];
  proposal?: {
    id: string;
    reply: string;
    plan: Plan;
    analysis: Row[];
    settings?: { constraints?: string; weeklyHours?: number };
  };
  undo?: unknown;
  error?: string;
};
type Props = {
  plan: Plan;
  data?: AssistantData;
  version: number;
  busy: boolean;
  dirty: boolean;
  configured: boolean;
  onBusy: (value: boolean) => void;
  run: (
    path: string,
    body: unknown,
    method?: string,
    signal?: AbortSignal,
  ) => Promise<Plan[] | undefined>;
  adopt: (p: Plan) => void;
};

function splitText(text: string, location: string): Part[] {
  const chars = Array.from(text);
  const result: Part[] = [];
  for (let i = 0; i < chars.length; i += 1100) {
    const value = chars
      .slice(i, i + 1100)
      .join("")
      .trim();
    if (value)
      result.push({
        id: "",
        location: `${location} · 段 ${result.length + 1}`,
        text: value,
      });
  }
  return result;
}
async function pdfSource(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<Part[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  signal?.throwIfAborted();
  const loading = pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
  });
  const abort = () => {
    void loading.destroy();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const parts: Part[] = [];
  try {
    const pdf = await loading.promise;
    for (let page = 1; page <= pdf.numPages; page++) {
      signal?.throwIfAborted();
      const p = await pdf.getPage(page);
      const content = await p.getTextContent();
      const text = content.items
        .map((x) =>
          "str" in x ? x.str + ("hasEOL" in x && x.hasEOL ? "\n" : " ") : "",
        )
        .join("");
      parts.push(...splitText(text, `第 ${page} 页`));
      if (parts.length > 500) throw new Error("PDF 超过500段，请按部分拆分。");
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await loading.destroy();
  }
  if (!parts.length)
    throw new Error(
      "未提取到文字；扫描件暂不支持 OCR，请提供文字版或粘贴正文。",
    );
  return parts;
}
function base64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
export function HourEstimate({
  nodes,
  weeklyHours,
}: {
  nodes: PlanNode[];
  weeklyHours: number;
}) {
  const hourly = nodes.filter((n) => n.hours);
  if (!hourly.length) return null;
  const low = hourly.reduce((v, n) => v + (n.hours || 0), 0),
    high = hourly.reduce((v, n) => v + (n.hoursHigh || n.hours || 0), 0);
  const personal = hourly.filter((n) => n.mode === "self");
  const ownLow = personal.reduce((v, n) => v + (n.hours || 0), 0),
    ownHigh = personal.reduce((v, n) => v + (n.hoursHigh || n.hours || 0), 0);
  const allSelf = nodes.every((n) => n.mode === "self" && n.hours);
  // Uniform weekly capacity; waits follow dependencies and may overlap other work.
  function horizon(upper: boolean) {
    const result = hourSchedule(nodes, weeklyHours, upper);
    return (
      Math.max(0, ...Array.from(result?.values() || []).map((x) => x.end)) / 7
    );
  }
  return (
    <div className="hour-estimate">
      <strong>
        工作量：{low.toFixed(1)}—{high.toFixed(1)} 小时
      </strong>
      <p>
        其中我的投入：{ownLow.toFixed(1)}—{ownHigh.toFixed(1)} 小时。
        {hourly.length !== nodes.length &&
          `另有 ${nodes.length - hourly.length} 个环节尚未估算小时。`}
      </p>
      {weeklyHours > 0 ? (
        <p>
          每周 {weeklyHours} 小时；我的净投入约{" "}
          {(ownLow / weeklyHours).toFixed(1)}—
          {(ownHigh / weeklyHours).toFixed(1)} 周。
          {allSelf &&
            `计入依赖与等待的暂定跨度约 ${horizon(false).toFixed(1)}—${horizon(true).toFixed(1)} 周。`}
          {!allSelf && "他人容量或部分工作量未知，暂不估算整个计划的完成时间。"}
        </p>
      ) : (
        <p>尚未设置每周容量，只展示工作量，不推算完成日期。</p>
      )}
      <small>
        估算不是承诺。每周容量均匀分配，未扣除节假日、其他计划与已完成工作。
      </small>
    </div>
  );
}
export function HourTimeline({
  nodes,
  weeklyHours,
}: {
  nodes: PlanNode[];
  weeklyHours: number;
}) {
  const low = hourSchedule(nodes, weeklyHours),
    high = hourSchedule(nodes, weeklyHours, true);
  return (
    <div className="hour-timeline">
      <p className="muted">
        {low
          ? "从相对第0周起算；包含依赖与等待，时间范围为估算。"
          : "容量或工作量尚未完整，暂展示各环节投入，不生成日期。"}
      </p>
      {nodes.map((n) => (
        <div className="hour-timeline-row" key={n.id}>
          <strong>
            {n.id} · {n.title}
          </strong>
          <span>
            {n.hours ? `${n.hours}—${n.hoursHigh} 小时` : "待估算"} · 等待{" "}
            {n.waitDays} 天
          </span>
          {low && high && (
            <small>
              相对第 {(low.get(n.id)!.start / 7).toFixed(1)}—
              {(high.get(n.id)!.end / 7).toFixed(1)} 周
            </small>
          )}
        </div>
      ))}
    </div>
  );
}
export function DraftAssistant({ onBusy, plan, data, busy, dirty, configured, run, adopt }: Props) {
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const controller = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { onBusy(working); return () => onBusy(false); }, [working, onBusy]);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [data?.messages?.length, status]);
  useEffect(() => {
    if (startedAt === null) { setElapsed(0); return; }
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  async function write(path: string, body: object, signal: AbortSignal, method = "POST") {
    signal.throwIfAborted();
    const plans = await run(path, { planId: plan.id, ...body }, method, signal);
    if (!plans) {
      throw new Error(
        signal.aborted
          ? "已停止。"
          : "页面状态刚刚更新，已重新同步；请再次点击发送。",
      );
    }
    const saved = plans.find(p => p.id === plan.id);
    if (saved && path !== "/assistant/source") adopt(saved);
  }
  async function source(file: File, signal: AbortSignal, url = "") {
    if (file.size > 5 * 1024 * 1024) throw new Error("附件超过5MB，请分成较小文件。");
    setStatus("正在读取附件…");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const parts = pdf ? await pdfSource(bytes, signal) : splitText(new TextDecoder().decode(bytes), "正文");
    await write("/assistant/source", { source: { name: file.name, url, parts, original: pdf ? base64(bytes) : "" } }, signal);
  }
  async function link(url: string, signal: AbortSignal) {
    setStatus("正在读取链接，网络较慢时会自动重试…");
    const stateResponse = await fetch("/api/state", { signal });
    if (!stateResponse.ok) throw new Error("读取当前计划失败，请重试。");
    const state = await stateResponse.json();
    if (state.assistants?.[plan.id]?.sources?.some((s: Source) => s.url === url)) return;
    const res = await fetch("/api/assistant/fetch", { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: state.version, planId: plan.id, url }) });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "链接读取失败");
    setStatus("正在提取资料正文…");
    const parts = result.kind === "pdf" ? await pdfSource(Uint8Array.from(atob(result.data), c => c.charCodeAt(0)), signal) : splitText(result.text, "网页正文");
    await write("/assistant/source", { source: { name: new URL(result.url).pathname.split("/").pop() || "链接资料", url: result.url, parts, original: result.data || "" } }, signal);
  }
  async function send(retry = false, undo = false) {
    if (locked.current || busy || (!undo && !configured)) return;
    if (!retry && !undo && !message.trim() && !attachments.length) return;
    locked.current = true;
    const abort = new AbortController();
    controller.current = abort;
    const signal = abort.signal;
    const sent = message;
    const files = [...attachments];
    setWorking(true); setStartedAt(Date.now()); setError("");
    if (!retry && !undo) setMessage("");
    try {
      if (dirty) {
        setStatus("正在保存你修改的环节…");
        await write("/plans", { plan: { ...plan, history: undefined } }, signal, "PUT");
      }
      if (undo) {
        setStatus("正在撤销…");
        await write("/assistant/undo", {}, signal);
      } else {
        for (const file of files) {
          await source(file, signal);
          setAttachments(current => current.filter(f => f !== file));
        }
        const urls = [...new Set(sent.match(/https:\/\/[^\s<>"）)\]]+/g) || [])];
        for (const url of retry ? [] : urls) await link(url, signal);
        setStatus("正在请求助手…");
        await write("/assistant/chat", { message: sent || "我添加了参考资料，请确认收到，等待我的下一条指令。", retry, autoApply: true }, signal);
        setStatus("已完成");
      }
    } catch (e) {
      setError(signal.aborted ? "已停止，你可以继续输入。" : e instanceof Error ? e.message : String(e));
      if (!retry && !undo) setMessage(current => current || sent);
    } finally {
      locked.current = false; setWorking(false); setStartedAt(null); setStatus("");
    }
  }
  function stop() {
    setStatus("正在停止…");
    controller.current?.abort();
  }
  const hasAssistantReply = data?.messages?.some(m => m.role !== "user");
  const runState = working
    ? `助手正在运行 · ${status || "准备中"} · 已用 ${elapsed} 秒`
    : error || data?.error
      ? "本轮已停止或失败 · 可以修改后重试"
      : hasAssistantReply
        ? "助手当前没有运行 · 上一轮已结束"
        : "助手等待你的指令";
  return <section className="draft-assistant chat-only" aria-label="草案助手">
    <header className="assistant-heading"><strong>草案助手</strong><small>直接对话，修改可撤销</small></header>
    <div className="assistant-body">
      <p className={"assistant-run-state " + (working ? "is-running" : "is-idle")} role="status">{working && <span className="assistant-spinner" aria-hidden="true" />}{runState}</p>
      <div className="assistant-messages" aria-live="polite">
        {!data?.messages?.length && <p className="assistant-empty">你想怎样调整这个计划？直接告诉我，也可以附上文件或粘贴链接。</p>}
        {data?.messages?.map(m => <article key={m.id} className={"assistant-message " + m.role}><strong>{m.role === "user" ? "你" : "助手"}</strong><p>{m.text}</p></article>)}
        <div ref={end} />
      </div>
      {!working && (error || data?.error) && <p role="alert" className="assistant-warning">{error || data?.error}</p>}
      <form onSubmit={e => { e.preventDefault(); void send(); }}>
        <textarea aria-label="消息" placeholder="输入你的指令…" value={message} maxLength={1600} onChange={e => setMessage(e.target.value)} />
        {attachments.map((file, i) => <span key={i}>{file.name} <button type="button" disabled={working} onClick={() => setAttachments(current => current.filter(f => f !== file))}>移除附件</button></span>)}
        <input ref={picker} type="file" accept=".pdf,.txt,.md" multiple hidden onChange={e => { setAttachments(current => [...current, ...Array.from(e.target.files || [])]); e.target.value = ""; }} />
        <div className="chat-actions">
          <button type="button" className="secondary" disabled={working || busy} onClick={() => picker.current?.click()}>附加文件</button>
          {working ? <button type="button" onClick={stop}>停止</button> : <button className="primary" disabled={busy || !configured || (!message.trim() && !attachments.length)}>发送</button>}
        </div>
      </form>
      {!configured && <p>请先在 AI API 配置中连接模型。</p>}
      {!working && data?.error && <button className="secondary" disabled={busy} onClick={() => void send(true)}>重试上条消息</button>}
      {!!data?.undo && <button className="secondary" disabled={working || busy || plan.status !== "draft"} onClick={() => void send(false, true)}>撤销上次修改</button>}
      {data?.proposal && plan.status !== "draft" && <p>已有修改建议；请将计划撤回草案后继续调整。</p>}
    </div>
  </section>;
}
