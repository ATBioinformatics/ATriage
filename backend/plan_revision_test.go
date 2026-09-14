package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestWithdrawReplanReacceptPreservesRecords(t *testing.T) {
	a := testApp(t)
	cookie, s := register(t, a, "replan@example.com")
	other, otherState := register(t, a, "replan-other@example.com")
	model := fixtureModel(t, samplePlan(), "stop")
	defer model.Close()
	a.aiBase, a.aiKey, a.aiModel = model.URL, "test", "mimo-test"
	s, standalone := create(t, a, cookie, s, "独立任务", "low")
	s = decodePlanState(t, call(t, a, "POST", "/api/plans/generate", map[string]any{"version": s.Version, "input": PlanInput{Goal: PlanField{Detail: "反馈试点"}}}, cookie))
	pid := s.Plans[0].ID
	s = decodePlanState(t, call(t, a, "POST", "/api/plans/accept", map[string]any{"version": s.Version, "planId": pid}, cookie))
	if call(t, a, "POST", "/api/plans/withdraw", map[string]any{"version": otherState.Version, "planId": pid}, other).Code != 400 {
		t.Fatal("cross account withdrawal")
	}
	if call(t, a, "POST", "/api/plans/withdraw", map[string]any{"version": s.Version - 1, "planId": pid}, cookie).Code != 409 {
		t.Fatal("stale withdrawal")
	}
	originalTask := s.Tasks[1]
	originalTask.Status = "done"
	originalTask.Deadline = "2026-10-01"
	w := call(t, a, "PUT", "/api/tasks", map[string]any{"version": s.Version, "task": originalTask}, cookie)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var result struct {
		State State `json:"state"`
	}
	json.Unmarshal(w.Body.Bytes(), &result)
	s = result.State
	s = decodePlanState(t, call(t, a, "POST", "/api/plans/withdraw", map[string]any{"version": s.Version, "planId": pid}, cookie))
	if len(s.Tasks) != 1 || !reflect.DeepEqual(s.Order, []string{standalone}) || s.Plans[0].Status != "draft" || len(s.Plans[0].History[0].Tasks) != 3 {
		t.Fatal("withdraw lost records or unrelated task")
	}
	if call(t, a, "PUT", "/api/tasks", map[string]any{"version": s.Version, "task": originalTask}, cookie).Code != 400 {
		t.Fatal("withdrawn task writable")
	}
	edited := s.Plans[0]
	edited.Nodes = append([]PlanNode(nil), edited.Nodes[:2]...)
	edited.Nodes[1].Title = "改为访谈调研"
	added := samplePlan().Nodes[2]
	added.ID = "D"
	added.Title = "新验收环节"
	edited.Nodes = append(edited.Nodes, added)
	revised := edited
	revised.Nodes = append([]PlanNode(nil), edited.Nodes...)
	revised.Nodes[1].DependsOn = []string{"A"}
	replacement := fixtureModel(t, revised, "stop")
	defer replacement.Close()
	a.aiBase = replacement.URL
	s = decodePlanState(t, call(t, a, "POST", "/api/plans/replan", map[string]any{"version": s.Version, "plan": edited}, cookie))
	if len(s.Tasks) != 1 || s.Plans[0].Nodes[2].ID != "D" || len(s.Plans[0].History) != 2 {
		t.Fatal("replan changed task list or lost history")
	}
	s = decodePlanState(t, call(t, a, "POST", "/api/plans/accept", map[string]any{"version": s.Version, "planId": pid}, cookie))
	if len(s.Tasks) != 4 || len(s.Order) != 3 {
		t.Fatal("duplicate task import")
	}
	var kept Task
	for _, task := range s.Tasks {
		if task.NodeID == "A" {
			kept = task
		}
		if task.NodeID == "C" {
			t.Fatal("removed task restored")
		}
	}
	if kept.ID != originalTask.ID || kept.Status != "done" || kept.Deadline != "2026-10-01" {
		t.Fatal("existing progress lost")
	}
	s = decodePlanState(t, call(t, a, "POST", "/api/plans/withdraw", map[string]any{"version": s.Version, "planId": pid}, cookie))
	s = decodePlanState(t, call(t, a, "POST", "/api/plans/accept", map[string]any{"version": s.Version, "planId": pid}, cookie))
	if len(s.Tasks) != 4 {
		t.Fatal("repeat cycle duplicated tasks")
	}
}

func TestReplanRejectsAIChangingUserNodes(t *testing.T) {
	a := testApp(t)
	in := samplePlan()
	cases := map[string]func(*Plan){
		"added":       func(p *Plan) { n := p.Nodes[0]; n.ID = "D"; p.Nodes = append(p.Nodes, n) },
		"removed":     func(p *Plan) { p.Nodes = p.Nodes[:2] },
		"renamed":     func(p *Plan) { p.Nodes[0].Title = "AI replacement" },
		"deliverable": func(p *Plan) { p.Nodes[0].Deliverable = "AI replacement" },
		"duplicate":   func(p *Plan) { p.Nodes[1] = p.Nodes[0] },
		"cycle":       func(p *Plan) { p.Nodes[0].DependsOn = []string{"C"} },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			output := samplePlan()
			change(&output)
			model := fixtureModel(t, output, "stop")
			defer model.Close()
			_, err := a.generatePlanWithNodes(context.Background(), PlanInput{Goal: PlanField{Detail: "test"}}, Profile{}, AIConfig{BaseURL: model.URL, APIKey: "test", Model: "mimo-test"}, &in)
			if err == nil {
				t.Fatal("invalid replan accepted")
			}
		})
	}
}

func TestReplanInputAndConcurrentEdit(t *testing.T) {
	a := testApp(t)
	cookie, s := register(t, a, "concurrent-replan@example.com")
	model := fixtureModel(t, samplePlan(), "stop")
	defer model.Close()
	a.aiBase, a.aiKey, a.aiModel = model.URL, "test", "mimo-test"
	s = decodePlanState(t, call(t, a, "POST", "/api/plans/generate", map[string]any{"version": s.Version, "input": PlanInput{Goal: PlanField{Detail: "test"}}}, cookie))
	original := s.Plans[0]
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if !strings.Contains(body.Messages[1].Content, "userNodes") || strings.Contains(body.Messages[1].Content, "history") {
			t.Error("incorrect replan model input")
		}
		create(t, a, cookie, s, "并发新增任务", "low")
		raw, _ := json.Marshal(samplePlan())
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": string(raw)}}}})
	}))
	defer server.Close()
	a.aiBase = server.URL
	w := call(t, a, "POST", "/api/plans/replan", map[string]any{"version": s.Version, "plan": original}, cookie)
	if w.Code != 409 {
		t.Fatal("stale AI overwrite", w.Code, w.Body.String())
	}
	current := decodePlanState(t, call(t, a, "GET", "/api/state", nil, cookie))
	if len(current.Tasks) != 1 || len(current.Plans[0].History) != 0 {
		t.Fatal("concurrent data lost")
	}
}

func TestChangedUpstreamResetsDependentCompletion(t *testing.T) {
	p := samplePlan()
	p.History = []PlanRevision{{Kind: "withdraw", Nodes: append([]PlanNode(nil), p.Nodes...)}}
	if !unchangedExecution(p, p.Nodes[2]) {
		t.Fatal("unchanged failed")
	}
	p.Nodes[0].Title = "不同工作"
	if unchangedExecution(p, p.Nodes[2]) {
		t.Fatal("changed prerequisite retained downstream completion")
	}
}
