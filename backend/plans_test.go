package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func samplePlan() Plan {
	return Plan{Title: "反馈试点", Summary: "先验证流程", Assumptions: []string{"角色和工期待确认"}, Questions: []string{}, Nodes: []PlanNode{
		{ID: "A", Title: "整理样本", Deliverable: "问题清单", Days: 2, WaitDays: 3, Priority: "high", Mode: "delegate", Owner: "教务", Reason: "可按标准整理", DependsOn: []string{}},
		{ID: "B", Title: "设计表单", Deliverable: "轻量流程", Days: 2, Priority: "medium", Mode: "delegate", Owner: "教务", Reason: "熟悉执行", DependsOn: []string{}},
		{ID: "C", Title: "确定方案", Deliverable: "确认方案", Days: 1, Priority: "high", Mode: "self", Owner: "我", Reason: "需要决策", DependsOn: []string{"A", "B"}},
	}}
}
func TestPlanScheduleWaitResourcesAndCriticalPath(t *testing.T) {
	p := samplePlan()
	if e := schedulePlan(&p); e != nil {
		t.Fatal(e)
	}
	if p.Nodes[0].End != 5 || p.Nodes[1].Start != 2 || p.Nodes[1].End != 4 || p.Nodes[2].Start != 5 || p.TotalDays != 6 {
		t.Fatalf("unexpected schedule %+v", p)
	}
	if !p.Nodes[0].Critical || p.Nodes[1].Critical || !p.Nodes[2].Critical {
		t.Fatal("critical path incorrect")
	}
	p.Nodes[1].Owner = "另一角色"
	if e := schedulePlan(&p); e != nil || p.Nodes[1].Start != 0 {
		t.Fatal("independent roles must overlap", e)
	}
}
func TestPlanRejectInvalidGraphAndBounds(t *testing.T) {
	cases := map[string]func(*Plan){"cycle": func(p *Plan) { p.Nodes[0].DependsOn = []string{"C"} }, "missing": func(p *Plan) { p.Nodes[0].DependsOn = []string{"missing"} }, "duplicate": func(p *Plan) { p.Nodes[1].ID = "A" }, "self": func(p *Plan) { p.Nodes[0].DependsOn = []string{"A"} }, "zeroDays": func(p *Plan) { p.Nodes[0].Days = 0 }, "negativeWait": func(p *Plan) { p.Nodes[0].WaitDays = -1 }, "noDeliverable": func(p *Plan) { p.Nodes[0].Deliverable = "" }, "invalidMode": func(p *Plan) { p.Nodes[0].Mode = "auto" }}
	for name, f := range cases {
		t.Run(name, func(t *testing.T) {
			p := samplePlan()
			f(&p)
			if schedulePlan(&p) == nil {
				t.Fatal("invalid plan accepted")
			}
		})
	}
}
func TestPlanInputOnlyGoalRequired(t *testing.T) {
	in := PlanInput{}
	if checkInput(&in) == nil {
		t.Fatal("empty goal accepted")
	}
	in.Goal.Detail = "  建立反馈流程  "
	if e := checkInput(&in); e != nil {
		t.Fatal(e)
	}
	if in.Goal.Detail != "建立反馈流程" {
		t.Fatal("not trimmed")
	}
	in.Resources.Detail = strings.Repeat("字", 2001)
	if checkInput(&in) == nil {
		t.Fatal("oversize accepted")
	}
}
func fixtureModel(t *testing.T, p Plan, finish string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["max_completion_tokens"].(float64) < 8000 {
			t.Error("insufficient budget")
		}
		raw, _ := json.Marshal(p)
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": finish, "message": map[string]string{"content": string(raw)}}}})
	}))
}
func decodePlanState(t *testing.T, w *httptest.ResponseRecorder) State {
	t.Helper()
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var s State
	if e := json.Unmarshal(w.Body.Bytes(), &s); e != nil {
		t.Fatal(e)
	}
	return s
}
func TestPlanLifecycleIsolationConflictAndDependencies(t *testing.T) {
	a := testApp(t)
	c, s := register(t, a, "planner@example.com")
	other, os := register(t, a, "otherplanner@example.com")
	model := fixtureModel(t, samplePlan(), "stop")
	defer model.Close()
	a.aiBase = model.URL
	a.aiKey = "test"
	a.aiModel = "mimo-test"
	s, existing := create(t, a, c, s, "已有人工任务", "low")
	oldOrder := append([]string{}, s.Order...)
	q := map[string]any{"version": s.Version, "input": PlanInput{Goal: PlanField{Detail: "改善家长反馈"}}}
	s = decodePlanState(t, call(t, a, "POST", "/api/plans/generate", q, c))
	if len(s.Plans) != 1 || len(s.Tasks) != 1 {
		t.Fatal("generation must persist only draft")
	}
	p := s.Plans[0]
	if len(p.Input.Current.Choices) != 0 || p.Input.Goal.Detail != "改善家长反馈" {
		t.Fatal("original input lost")
	}
	if call(t, a, "POST", "/api/plans/accept", map[string]any{"version": os.Version, "planId": p.ID}, other).Code != 400 {
		t.Fatal("foreign plan accepted")
	}
	if strings.Contains(call(t, a, "GET", "/api/state", nil, other).Body.String(), p.ID) {
		t.Fatal("plan leaked")
	}
	p.Nodes[0].Days = 3
	s = decodePlanState(t, call(t, a, "PUT", "/api/plans", map[string]any{"version": s.Version, "plan": p}, c))
	if s.Plans[0].TotalDays != 7 {
		t.Fatal("edit not recalculated")
	}
	if call(t, a, "POST", "/api/plans/accept", map[string]any{"version": s.Version - 1, "planId": p.ID}, c).Code != 409 {
		t.Fatal("stale accepted")
	}
	s = decodePlanState(t, call(t, a, "POST", "/api/plans/accept", map[string]any{"version": s.Version, "planId": p.ID}, c))
	if len(s.Tasks) != 4 || s.Order[0] != existing || s.Order[0] != oldOrder[0] || s.Plans[0].Status != "accepted" {
		t.Fatal("bad import")
	}
	if call(t, a, "POST", "/api/plans/accept", map[string]any{"version": s.Version, "planId": p.ID}, c).Code != 400 {
		t.Fatal("duplicate import")
	}
	if call(t, a, "PUT", "/api/plans", map[string]any{"version": s.Version, "plan": p}, c).Code != 400 {
		t.Fatal("accepted snapshot editable")
	}
	child := s.Tasks[3]
	child.Status = "done"
	child.Dependencies = nil
	if call(t, a, "PUT", "/api/tasks", map[string]any{"version": s.Version, "task": child}, c).Code != 400 {
		t.Fatal("dependency bypass")
	}
	for _, i := range []int{1, 2} {
		task := s.Tasks[i]
		task.Status = "done"
		w := call(t, a, "PUT", "/api/tasks", map[string]any{"version": s.Version, "task": task}, c)
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		var out struct {
			State State `json:"state"`
		}
		json.Unmarshal(w.Body.Bytes(), &out)
		s = out.State
	}
	if call(t, a, "PUT", "/api/tasks", map[string]any{"version": s.Version, "task": child}, c).Code != 200 {
		t.Fatal("completed prerequisites did not unblock")
	}
}
func TestPlanModelRejectsTruncatedOrInvalidOutput(t *testing.T) {
	a := testApp(t)
	for _, finish := range []string{"length", "content_filter", ""} {
		t.Run(finish, func(t *testing.T) {
			server := fixtureModel(t, samplePlan(), finish)
			defer server.Close()
			_, e := a.generatePlan(context.Background(), PlanInput{Goal: PlanField{Detail: "目标"}}, Profile{}, AIConfig{BaseURL: server.URL, APIKey: "test", Model: "mimo-test"})
			if e == nil {
				t.Fatal("incomplete response accepted")
			}
		})
	}
	p := samplePlan()
	p.Nodes[0].DependsOn = []string{"C"}
	server := fixtureModel(t, p, "stop")
	defer server.Close()
	if _, e := a.generatePlan(context.Background(), PlanInput{Goal: PlanField{Detail: "目标"}}, Profile{}, AIConfig{BaseURL: server.URL, APIKey: "test", Model: "mimo-test"}); e == nil {
		t.Fatal("cyclic model response accepted")
	}
}

func TestGoalOnlyDirectGenerationSerializesEmptyChoicesAsArrays(t *testing.T) {
	a := testApp(t)
	server := fixtureModel(t, samplePlan(), "stop")
	defer server.Close()
	p, err := a.generatePlan(context.Background(), PlanInput{Goal: PlanField{Detail: "仅一个目标"}}, Profile{}, AIConfig{BaseURL: server.URL, APIKey: "test", Model: "mimo-test"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(p.Input)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "null") || strings.Count(string(b), `"choices":[]`) != 6 {
		t.Fatalf("invalid optional fields: %s", b)
	}
}
func TestPlanGenerationDoesNotOverwriteConcurrentEdit(t *testing.T) {
	a := testApp(t)
	c, s := register(t, a, "concurrentplanner@example.com")
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(c)
	id, _ := a.user(r)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, e := a.update(id, s.Version, func(s *State) error { s.Profile.Name = "changed"; return nil })
		if e != nil {
			t.Error(e)
		}
		raw, _ := json.Marshal(samplePlan())
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": string(raw)}}}})
	}))
	defer model.Close()
	a.aiBase = model.URL
	a.aiKey = "test"
	a.aiModel = "mimo-test"
	w := call(t, a, "POST", "/api/plans/generate", map[string]any{"version": s.Version, "input": PlanInput{Goal: PlanField{Detail: "目标"}}}, c)
	if w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	current, _ := a.state(id)
	if len(current.Plans) != 0 || current.Profile.Name != "changed" {
		t.Fatal("concurrent change overwritten")
	}
}

// Opt-in browser acceptance server; isolated data, synthetic account, credentials
// read only from the existing local encrypted config and held only in memory.
func TestPlanBrowserAcceptance(t *testing.T) {
	if os.Getenv("ATRIAGE_PLAN_BROWSER") != "1" && os.Getenv("ATRIAGE_PLAN_LIVE") != "1" {
		t.Skip("manual browser acceptance only")
	}
	a, e := openApp(filepath.Join(t.TempDir(), "browser.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer a.db.Close()
	db, e := sql.Open("sqlite", "file:data/atriage.db?mode=ro")
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	key, e := os.ReadFile("data/atriage-secret.key")
	if e != nil {
		t.Fatal(e)
	}
	var nonce, encrypted []byte
	if e = db.QueryRow("SELECT nonce,encrypted FROM ai_configs ORDER BY verified_at DESC LIMIT 1").Scan(&nonce, &encrypted); e != nil {
		t.Fatal(e)
	}
	decoder := &App{secretKey: key}
	cfg, e := decoder.openConfig(nonce, encrypted)
	if e != nil {
		t.Fatal("cannot read saved config")
	}
	a.aiBase, a.aiKey, a.aiModel = cfg.BaseURL, cfg.APIKey, cfg.Model
	if os.Getenv("ATRIAGE_PLAN_LIVE") == "1" {
		started := time.Now()
		p, err := a.generatePlan(context.Background(), PlanInput{Goal: PlanField{Detail: "六周内建立一套教师课堂反馈机制，先做一个年级的试点；我只想负责关键决策，希望资料整理和执行由协助者推进。"}}, Profile{Role: "Principal", Rule: "保留我的时间处理关键决策"}, cfg)
		if err != nil {
			t.Fatal(err)
		}
		counts := map[string]int{}
		for _, n := range p.Nodes {
			counts[n.Mode]++
		}
		t.Logf("Live planning passed: tasks=%d days=%d roles=%v elapsed=%s", len(p.Nodes), p.TotalDays, counts, time.Since(started).Round(time.Second))
		return
	}
	c, s := register(t, a, "v02-test@example.com")
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(c)
	id, _ := a.user(r)
	_, e = a.update(id, s.Version, func(s *State) error { s.Profile.Onboarded = true; return nil })
	if e != nil {
		t.Fatal(e)
	}
	mux := http.NewServeMux()
	mux.Handle("/api/", a)
	mux.Handle("/", http.FileServer(http.Dir("../frontend/dist")))
	srv := &http.Server{Addr: "127.0.0.1:8092", Handler: mux, ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 105 * time.Second}
	t.Log("Isolated browser acceptance: http://127.0.0.1:8092 ; synthetic account v02-test@example.com")
	t.Fatal(srv.ListenAndServe())
}
