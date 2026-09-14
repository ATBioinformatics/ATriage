import type { Plan } from './Planner';

type Action = { id: string; title: string; status: string; planId?: string; nodeId?: string; dependencies?: string[]; deadline: string };
export function goalView<T extends Action>(plans: Plan[], tasks: T[]) {
  const groups = plans.map(plan => {
    const matches = tasks.filter(t => !t.planId && t.title === plan.input?.goal?.detail);
    const source = tasks.find(t => t.id === plan.sourceTaskId) || (matches.length === 1 && plans.filter(p => p.input?.goal?.detail === plan.input?.goal?.detail).length === 1 ? matches[0] : undefined);
    const children = tasks.filter(t => t.planId === plan.id);
    const ready = children.filter(t => t.status === 'open' && (t.dependencies || []).every(id => tasks.find(x => x.id === id)?.status === 'done'));
    const preview = plan.status === 'draft' ? plan.nodes.filter(n => !(n.dependsOn || []).length) : [];
    return { plan, source, children, ready, preview, done: children.filter(t => t.status === 'done').length };
  }).filter(g => g.plan.status === 'draft' || g.children.some(t => t.status === 'open') || g.source?.status === 'open');
  const sources = new Set(groups.map(g => g.source?.id));
  const standalone = tasks.filter(t => t.status === 'open' && !sources.has(t.id) && !plans.some(p => p.id === t.planId));
  return { groups, standalone };
}
