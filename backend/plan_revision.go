package main

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

type PlanRevision struct {
	Created string     `json:"created"`
	Kind    string     `json:"kind"`
	Nodes   []PlanNode `json:"nodes"`
	Tasks   []Task     `json:"tasks,omitempty"`
}

func withdrawPlan(s *State, index int) error {
	p := &s.Plans[index]
	if p.Status != "accepted" {
		return errors.New("只有已确认的计划可以撤回草案")
	}
	revision := PlanRevision{Kind: "withdraw", Created: time.Now().UTC().Format(time.RFC3339Nano), Nodes: append([]PlanNode(nil), p.Nodes...)}
	removed := map[string]bool{}
	for _, t := range s.Tasks {
		if t.PlanID == p.ID {
			revision.Tasks = append(revision.Tasks, t)
			removed[t.ID] = true
			for i := range revision.Nodes {
				if revision.Nodes[i].ID == t.NodeID {
					revision.Nodes[i].Title = t.Title
				}
			}
		}
	}
	for _, t := range s.Tasks {
		if t.PlanID != p.ID {
			for _, dep := range t.Dependencies {
				if removed[dep] {
					return errors.New("其他计划仍依赖这些执行项，请先调整关联")
				}
			}
		}
	}
	tasks := make([]Task, 0, len(s.Tasks))
	order := make([]string, 0, len(s.Order))
	for _, t := range s.Tasks {
		if !removed[t.ID] {
			tasks = append(tasks, t)
		}
	}
	for _, id := range s.Order {
		if !removed[id] {
			order = append(order, id)
		}
	}
	s.Tasks, s.Order = tasks, order
	p.Nodes = append([]PlanNode(nil), revision.Nodes...)
	p.History = append(p.History, revision)
	p.Status = "draft"
	return nil
}

func lastExecution(p Plan) *PlanRevision {
	for i := len(p.History) - 1; i >= 0; i-- {
		if p.History[i].Kind == "withdraw" {
			return &p.History[i]
		}
	}
	return nil
}

func priorExecution(p Plan, nodeID string) (Task, bool) {
	if revision := lastExecution(p); revision != nil {
		for _, t := range revision.Tasks {
			if t.NodeID == nodeID {
				return t, true
			}
		}
	}
	return Task{}, false
}

func unchangedExecution(p Plan, node PlanNode) bool {
	revision := lastExecution(p)
	if revision == nil {
		return false
	}
	old := map[string]PlanNode{}
	current := map[string]PlanNode{}
	for _, n := range revision.Nodes {
		old[n.ID] = n
	}
	for _, n := range p.Nodes {
		current[n.ID] = n
	}
	visited := map[string]bool{}
	var same func(string) bool
	same = func(id string) bool {
		if visited[id] {
			return true
		}
		visited[id] = true
		a, ok := old[id]
		b, exists := current[id]
		if !ok || !exists || a.Title != b.Title || a.Deliverable != b.Deliverable {
			return false
		}
		da, db := slices.Clone(a.DependsOn), slices.Clone(b.DependsOn)
		slices.Sort(da)
		slices.Sort(db)
		if !slices.Equal(da, db) {
			return false
		}
		for _, dep := range b.DependsOn {
			if !same(dep) {
				return false
			}
		}
		return true
	}
	return same(node.ID)
}

// User-owned contents can be edited without supplying a valid dependency graph.
func validateReplanInput(p Plan) error {
	if strings.TrimSpace(p.Title) == "" || utf8.RuneCountInString(p.Title) > 300 || len(p.Nodes) < 1 || len(p.Nodes) > 30 {
		return errors.New("请填写计划标题，并保留 1—30 个环节")
	}
	seen := map[string]bool{}
	for _, n := range p.Nodes {
		if !nodeID.MatchString(n.ID) || seen[n.ID] {
			return errors.New("环节编号无效或重复")
		}
		seen[n.ID] = true
		if strings.TrimSpace(n.Title) == "" || utf8.RuneCountInString(n.Title) > 300 || strings.TrimSpace(n.Deliverable) == "" || utf8.RuneCountInString(n.Deliverable) > 1000 || utf8.RuneCountInString(n.Reason) > 600 || utf8.RuneCountInString(n.Owner) > 80 || len(n.DependsOn) > 30 {
			return errors.New("请填写环节名称和预期产出，并检查文字长度")
		}
	}
	return nil
}

func validateFixedNodes(input, output Plan) error {
	if len(input.Nodes) != len(output.Nodes) {
		return errors.New("AI 改变了环节数量，结果未保存；请重试")
	}
	expected := map[string]PlanNode{}
	for _, n := range input.Nodes {
		expected[n.ID] = n
	}
	for _, n := range output.Nodes {
		original, ok := expected[n.ID]
		if !ok || n.Title != original.Title || n.Deliverable != original.Deliverable {
			return errors.New("AI 改变了你编辑的环节内容，结果未保存；请重试")
		}
		delete(expected, n.ID)
	}
	return nil
}

func (a *App) replan(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != "POST" {
		fail(w, 405, "请求方法不支持")
		return
	}
	var q struct {
		Version int  `json:"version"`
		Plan    Plan `json:"plan"`
	}
	if !decode(w, r, &q) {
		return
	}
	s, e := a.state(id)
	if e != nil {
		fail(w, 500, "读取失败")
		return
	}
	if s.Version != q.Version {
		updated(w, s, conflict)
		return
	}
	var original *Plan
	for i := range s.Plans {
		if s.Plans[i].ID == q.Plan.ID {
			original = &s.Plans[i]
			break
		}
	}
	if original == nil {
		fail(w, 400, "计划不存在或不属于当前账号")
		return
	}
	if original.Status != "draft" {
		fail(w, 400, "请先将计划撤回草案，再编辑编排")
		return
	}
	if e = validateReplanInput(q.Plan); e != nil {
		fail(w, 400, e.Error())
		return
	}
	if !a.allow("ai:"+id, 10, time.Minute) {
		fail(w, 429, "规划请求较多，请一分钟后重试")
		return
	}
	config, _, e := a.config(id)
	if e != nil {
		fail(w, 500, "暂时无法读取 AI 配置")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	planned, e := a.generatePlanWithNodes(ctx, original.Input, s.Profile, config, &q.Plan)
	if e != nil {
		fail(w, 422, e.Error())
		return
	}
	ns, e := a.update(id, q.Version, func(s *State) error {
		for i := range s.Plans {
			old := s.Plans[i]
			if old.ID != q.Plan.ID {
				continue
			}
			if old.Status != "draft" {
				return errors.New("计划状态已变化，请刷新")
			}
			planned.ID, planned.Title, planned.Input, planned.SourceTaskID, planned.Created = old.ID, q.Plan.Title, old.Input, old.SourceTaskID, old.Created
			planned.History = append(old.History, PlanRevision{Kind: "replan", Created: time.Now().UTC().Format(time.RFC3339Nano), Nodes: old.Nodes})
			s.Plans[i] = planned
			return nil
		}
		return errors.New("计划不存在")
	})
	updated(w, ns, e)
}
