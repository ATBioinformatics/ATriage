package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDraftDownloadRetriesPartialBody(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("Content-Length", "100")
			io.WriteString(w, "%PDF-partial")
			return
		}
		io.WriteString(w, "%PDF-complete")
	}))
	defer server.Close()
	req, _ := http.NewRequest("GET", server.URL, nil)
	_, body, err := readDraftDownload(server.Client(), req)
	if err != nil || string(body) != "%PDF-complete" || calls != 2 {
		t.Fatalf("calls=%d body=%q err=%v", calls, body, err)
	}
}

func TestDraftDownloadCancellationDoesNotRetry(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://example.com", nil)
	_, body, err := readDraftDownload(http.DefaultClient, req)
	if err == nil || !strings.Contains(err.Error(), "已停止") || body != nil {
		t.Fatalf("body=%q err=%v", body, err)
	}
}

func TestAssistantCancellationRetainsInputAndRejectsLateProposal(t *testing.T) {
	a, c, s, user := seedAssistant(t)
	started := make(chan struct{})
	cancelled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		close(started)
		select {
		case <-r.Context().Done():
			close(cancelled)
		case <-time.After(5 * time.Second):
		}
	}))
	defer server.Close()
	a.aiBase = server.URL
	a.aiKey = "test"
	a.aiModel = "mimo-test"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	body, _ := json.Marshal(map[string]any{"version": s.Version, "planId": "plan", "message": "讨论下一步"})
	r := httptest.NewRequest("POST", "/api/assistant/chat", strings.NewReader(string(body))).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(c)
	done := make(chan struct{})
	go func() { a.ServeHTTP(httptest.NewRecorder(), r); close(done) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("model did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not stop")
	}
	select {
	case <-cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("model request did not cancel")
	}
	current, e := a.state(user)
	if e != nil {
		t.Fatal(e)
	}
	d := current.Assistants["plan"]
	if len(d.Messages) != 1 || d.Proposal != nil || !strings.Contains(d.Error, "已停止") {
		t.Fatal("cancelled result lost input or saved a proposal")
	}
}

func assistantFixture(t *testing.T, a *App, answer func(string) (any, string)) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			t.Error("bad request")
		}
		if len(req.Messages) != 2 {
			t.Error("unexpected history transport")
		}
		if len(req.Messages[0].Content)+len(req.Messages[1].Content) > assistantBudget {
			t.Error("context budget exceeded")
		}
		value, finish := answer(req.Messages[1].Content)
		b, _ := json.Marshal(value)
		send(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": finish, "message": map[string]string{"content": string(b)}}}})
	}))
	t.Cleanup(server.Close)
	a.aiBase = server.URL
	a.aiKey = "test"
	a.aiModel = "mimo-test"
	return server
}
func seedAssistant(t *testing.T) (*App, *http.Cookie, State, string) {
	t.Helper()
	a := testApp(t)
	c, s := register(t, a, "draft@example.com")
	var user string
	if e := a.db.QueryRow("SELECT id FROM users WHERE email=?", "draft@example.com").Scan(&user); e != nil {
		t.Fatal(e)
	}
	s, e := a.update(user, s.Version, func(s *State) error {
		p := samplePlan()
		p.ID = "plan"
		p.Status = "draft"
		p.Input.Goal.Detail = "推进项目并交付首版"
		schedulePlan(&p)
		s.Plans = append(s.Plans, p)
		return nil
	})
	if e != nil {
		t.Fatal(e)
	}
	return a, c, s, user
}
func draftCall(t *testing.T, a *App, c *http.Cookie, s State, path string, body map[string]any) State {
	t.Helper()
	body["version"] = s.Version
	body["planId"] = "plan"
	w := call(t, a, "POST", "/api/assistant/"+path, body, c)
	if w.Code != 200 {
		t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
	}
	var next State
	if e := json.Unmarshal(w.Body.Bytes(), &next); e != nil {
		t.Fatal(e)
	}
	return next
}
func hourlyPlan(p Plan) Plan {
	p = clonePlan(p)
	for i := range p.Nodes {
		p.Nodes[i].Hours = 2
		p.Nodes[i].HoursHigh = 4
		p.Nodes[i].EstimateBasis = "待诊断后的暂定估算"
	}
	return p
}

func TestEmptyDraftSaveChatApplyUndo(t *testing.T) {
	a, c, s, user := seedAssistant(t)
	next := hourlyPlan(s.Plans[0])
	for i := range next.Nodes {
		next.Nodes[i].ID = "new-" + next.Nodes[i].ID
		for j := range next.Nodes[i].DependsOn {
			next.Nodes[i].DependsOn[j] = "new-" + next.Nodes[i].DependsOn[j]
		}
	}
	s = draftCall(t, a, c, s, "settings", map[string]any{"constraints": "保留预算限制", "weeklyHours": 6, "locked": []string{"A"}})
	empty := clonePlan(s.Plans[0])
	empty.Nodes = []PlanNode{}
	w := call(t, a, "PUT", "/api/plans", map[string]any{"version": s.Version, "plan": empty}, c)
	if w.Code != 200 {
		t.Fatalf("empty autosave blocked chat: %s", w.Body.String())
	}
	s, _ = a.state(user)
	if len(s.Plans[0].Nodes) != 0 || s.Plans[0].TotalDays != 0 || len(s.Plans[0].History) == 0 || len(s.Assistants["plan"].Locked) != 0 {
		t.Fatal("empty draft or removed locks not persisted")
	}
	w = call(t, a, "POST", "/api/plans/accept", map[string]any{"version": s.Version, "planId": "plan"}, c)
	if w.Code == 200 {
		t.Fatal("empty draft became executable")
	}
	assistantFixture(t, a, func(raw string) (any, string) {
		var input struct {
			Plan        Plan     `json:"plan"`
			Retired     []string `json:"retiredNodeIds"`
			Constraints string   `json:"constraints"`
		}
		if err := json.Unmarshal([]byte(raw), &input); err != nil {
			t.Error(err)
		}
		if len(input.Plan.Nodes) != 0 || len(input.Retired) != 3 || input.Plan.Input.Goal.Detail == "" || input.Constraints != "保留预算限制" {
			t.Errorf("lost regeneration context: %+v", input)
		}
		return map[string]any{"reply": "已重新生成草案", "plan": next}, "stop"
	})
	s = draftCall(t, a, c, s, "chat", map[string]any{"message": "删除旧方案后重新生成行动路径与排期"})
	if s.Assistants["plan"].Proposal == nil {
		t.Fatalf("no proposal: %+v", s.Assistants["plan"])
	}
	s = draftCall(t, a, c, s, "apply", map[string]any{"proposalId": s.Assistants["plan"].Proposal.ID})
	if len(s.Plans[0].Nodes) != 3 || s.Plans[0].Nodes[0].ID != "new-A" {
		t.Fatal("new draft not applied")
	}
	s = draftCall(t, a, c, s, "undo", map[string]any{})
	if len(s.Plans[0].Nodes) != 0 {
		t.Fatal("undo resurrected deleted tasks")
	}
}

func TestAssistantProposalApplyUndoAndIsolation(t *testing.T) {
	a, c, s, _ := seedAssistant(t)
	next := hourlyPlan(s.Plans[0])
	next.Nodes[0].Title = "盘点syllabus小章节"
	next.Nodes = append(next.Nodes, PlanNode{ID: "D", Title: "基础诊断", Deliverable: "诊断记录", Days: 1, Hours: 1, HoursHigh: 2, EstimateBasis: "暂定", Priority: "medium", PLevel: "P1", Mode: "self", Owner: "我", Reason: "定位补缺", DependsOn: []string{"A"}})
	assistantFixture(t, a, func(string) (any, string) {
		return map[string]any{"reply": "先盘点小章节并诊断。", "plan": next}, "stop"
	})
	s = draftCall(t, a, c, s, "chat", map[string]any{"message": "先分析小章节"})
	d := s.Assistants["plan"]
	if len(d.Messages) != 2 || d.Proposal == nil || s.Plans[0].Nodes[0].Title == next.Nodes[0].Title {
		t.Fatal("chat mutated plan or lost proposal")
	}
	other, os := register(t, a, "otherdraft@example.com")
	w := call(t, a, "POST", "/api/assistant/apply", map[string]any{"version": os.Version, "planId": "plan", "proposalId": d.Proposal.ID}, other)
	if w.Code != 400 {
		t.Fatal("cross-account application")
	}
	s = draftCall(t, a, c, s, "apply", map[string]any{"proposalId": d.Proposal.ID})
	if len(s.Plans[0].Nodes) != 4 || s.Assistants["plan"].Undo == nil {
		t.Fatal("application failed")
	}
	s = draftCall(t, a, c, s, "undo", map[string]any{})
	if len(s.Plans[0].Nodes) != 3 || len(s.Assistants["plan"].Messages) != 2 {
		t.Fatal("undo lost original or conversation")
	}
}
func TestAssistantStaleProposalAndAcceptedGuard(t *testing.T) {
	a, c, s, _ := seedAssistant(t)
	next := hourlyPlan(s.Plans[0])
	assistantFixture(t, a, func(string) (any, string) { return map[string]any{"reply": "修改提案", "plan": next}, "stop" })
	s = draftCall(t, a, c, s, "chat", map[string]any{"message": "修改"})
	pid := s.Assistants["plan"].Proposal.ID
	s = draftCall(t, a, c, s, "settings", map[string]any{"constraints": "只做AS", "weeklyHours": 6})
	w := call(t, a, "POST", "/api/assistant/apply", map[string]any{"version": s.Version, "planId": "plan", "proposalId": pid}, c)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "已变化") {
		t.Fatal("stale proposal accepted", w.Body.String())
	}
	s = draftCall(t, a, c, s, "chat", map[string]any{"message": "按新约束修改"})
	pid = s.Assistants["plan"].Proposal.ID
	w = call(t, a, "POST", "/api/plans/accept", map[string]any{"version": s.Version, "planId": "plan"}, c)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	json.Unmarshal(w.Body.Bytes(), &s)
	w = call(t, a, "POST", "/api/assistant/apply", map[string]any{"version": s.Version, "planId": "plan", "proposalId": pid}, c)
	if w.Code != 400 {
		t.Fatal("accepted plan changed")
	}
}
func TestAssistantFailedOutputRetainsMessageAndRetries(t *testing.T) {
	a, c, s, _ := seedAssistant(t)
	n := 0
	assistantFixture(t, a, func(string) (any, string) {
		n++
		if n == 1 {
			return map[string]any{"reply": "半句话"}, "length"
		}
		return map[string]any{"reply": "请确认课程代码与年份"}, "stop"
	})
	s = draftCall(t, a, c, s, "chat", map[string]any{"message": "按 syllabus 拆解"})
	if s.Assistants["plan"].Error == "" || len(s.Assistants["plan"].Messages) != 1 {
		t.Fatal("failed input lost")
	}
	s = draftCall(t, a, c, s, "chat", map[string]any{"retry": true})
	if s.Assistants["plan"].Error != "" || len(s.Assistants["plan"].Messages) != 2 {
		t.Fatal("retry duplicated input")
	}
}

func TestAssistantMalformedPlanDoesNotSurfaceTaskCountValidator(t *testing.T) {
	a, c, s, _ := seedAssistant(t)
	assistantFixture(t, a, func(string) (any, string) {
		return map[string]any{
			"reply": "我会继续梳理行动路径。",
			"plan":  Plan{Title: "半份草案"},
		}, "stop"
	})
	next := draftCall(t, a, c, s, "chat", map[string]any{"message": "请粗拆行动路径"})
	d := next.Assistants["plan"]
	if d.Error != "" || d.Proposal != nil || len(d.Messages) != 2 {
		t.Fatalf("malformed plan blocked discussion: error=%q proposal=%v messages=%d", d.Error, d.Proposal != nil, len(d.Messages))
	}
	if !strings.Contains(d.Messages[1].Text, "没有修改现有计划") {
		t.Fatal("user did not receive a natural continuation message", d.Messages[1].Text)
	}
}

func TestAssistantLaterDiscussionInvalidatesProposalButAllowsUndo(t *testing.T) {
	a, c, s, _ := seedAssistant(t)
	n := 0
	assistantFixture(t, a, func(string) (any, string) {
		n++
		if n == 2 || n == 4 {
			return map[string]any{"reply": "先讨论，不修改"}, "stop"
		}
		return map[string]any{"reply": "暂定修改", "plan": hourlyPlan(s.Plans[0])}, "stop"
	})
	s = draftCall(t, a, c, s, "chat", map[string]any{"message": "修改"})
	pid := s.Assistants["plan"].Proposal.ID
	s = draftCall(t, a, c, s, "chat", map[string]any{"message": "暂缓刚才的思路"})
	w := call(t, a, "POST", "/api/assistant/apply", map[string]any{"version": s.Version, "planId": "plan", "proposalId": pid}, c)
	if w.Code != 400 {
		t.Fatal("old conversational proposal applied")
	}
	s = draftCall(t, a, c, s, "chat", map[string]any{"message": "重新修改"})
	s = draftCall(t, a, c, s, "apply", map[string]any{"proposalId": s.Assistants["plan"].Proposal.ID})
	s = draftCall(t, a, c, s, "chat", map[string]any{"message": "解释估算"})
	s = draftCall(t, a, c, s, "undo", map[string]any{})
	if s.Plans[0].Nodes[0].Hours != 0 {
		t.Fatal("discussion prevented undo")
	}
}

func TestAssistantCapacityProposalAndUndo(t *testing.T) {
	a, c, s, _ := seedAssistant(t)
	hours := 6.0
	constraints := "只做AS"
	assistantFixture(t, a, func(string) (any, string) {
		return map[string]any{"reply": "每周容量改为6小时，供预览", "plan": hourlyPlan(s.Plans[0]), "settings": DraftSettings{WeeklyHours: &hours, Constraints: &constraints}}, "stop"
	})
	s = draftCall(t, a, c, s, "chat", map[string]any{"message": "每周只有六小时，只做AS，调整草案"})
	if s.Assistants["plan"].WeeklyHours != 0 {
		t.Fatal("settings applied during chat")
	}
	s = draftCall(t, a, c, s, "apply", map[string]any{"proposalId": s.Assistants["plan"].Proposal.ID})
	if s.Assistants["plan"].WeeklyHours != 6 || s.Assistants["plan"].Constraints != "只做AS" {
		t.Fatal("settings not applied with proposal")
	}
	s = draftCall(t, a, c, s, "undo", map[string]any{})
	if s.Assistants["plan"].WeeklyHours != 0 || s.Assistants["plan"].Constraints != "" {
		t.Fatal("undo lost prior settings")
	}
}
func TestAssistantLockedNodesAndInvalidReferences(t *testing.T) {
	old := samplePlan()
	schedulePlan(&old)
	p := hourlyPlan(old)
	d := &DraftAssistant{Locked: []string{"A"}}
	if validateDraftProposal(p, old, d, nil) == nil {
		t.Fatal("locked estimate modified")
	}
	p.Nodes[0] = old.Nodes[0]
	if e := validateDraftProposal(p, old, d, nil); e != nil {
		t.Fatal(e)
	}
	p.Nodes[0].Title = "改动"
	if validateDraftProposal(p, old, d, nil) == nil {
		t.Fatal("locked title modified")
	}
	d.Locked = nil
	p = hourlyPlan(old)
	p.Nodes[0].Refs = []string{"fake"}
	if validateDraftProposal(p, old, d, nil) == nil {
		t.Fatal("invented reference accepted")
	}
}
func TestAssistantConcurrentChangePreservesUserInput(t *testing.T) {
	a, c, s, user := seedAssistant(t)
	assistantFixture(t, a, func(string) (any, string) {
		current, _ := a.state(user)
		_, e := a.update(user, current.Version, func(s *State) error { s.Plans[0].Title = "人工新标题"; return nil })
		if e != nil {
			t.Error(e)
		}
		return map[string]any{"reply": "旧回复", "plan": hourlyPlan(s.Plans[0])}, "stop"
	})
	w := call(t, a, "POST", "/api/assistant/chat", map[string]any{"version": s.Version, "planId": "plan", "message": "请改"}, c)
	if w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	current, _ := a.state(user)
	if current.Plans[0].Title != "人工新标题" || len(current.Assistants["plan"].Messages) != 1 {
		t.Fatal("concurrent edit overwritten")
	}
}
func TestAssistantRepeatedCompactionBudgetAndOriginals(t *testing.T) {
	a, c, s, user := seedAssistant(t)
	summaryCalls := 0
	assistantFixture(t, a, func(raw string) (any, string) {
		var input map[string]json.RawMessage
		json.Unmarshal([]byte(raw), &input)
		if input["previous"] != nil {
			summaryCalls++
			var msgs []DraftMessage
			json.Unmarshal(input["messages"], &msgs)
			return map[string]any{"memory": []MemoryItem{{Kind: "decision", Text: "旧容量已替代；以独立保存的每周6小时为准", Evidence: []string{msgs[0].ID}}}}, "stop"
		}
		if !strings.Contains(raw, "已确认：只做AS") || !strings.Contains(raw, `"weeklyHours":6`) {
			t.Error("authoritative constraints missing")
		}
		return map[string]any{"reply": "保持AS范围，按六小时估算"}, "stop"
	})
	s = draftCall(t, a, c, s, "settings", map[string]any{"constraints": "已确认：只做AS", "weeklyHours": 6, "locked": []string{"A"}})
	for round := 0; round < 3; round++ {
		var e error
		s, e = a.update(user, s.Version, func(s *State) error {
			_, d, _ := draftState(s, "plan")
			for i := 0; i < 12; i++ {
				d.Messages = append(d.Messages, DraftMessage{ID: uid(), Role: "user", Text: strings.Repeat("历史讨论内容", 180)})
			}
			return nil
		})
		if e != nil {
			t.Fatal(e)
		}
		s = draftCall(t, a, c, s, "chat", map[string]any{"message": "继续"})
	}
	d := s.Assistants["plan"]
	if d.Error != "" {
		t.Fatal(d.Error)
	}
	if summaryCalls < 3 || d.Compactions < 3 || len(d.Messages) != 42 || d.ContextBytes > assistantBudget || d.Constraints != "已确认：只做AS" || len(d.Locked) != 1 {
		t.Fatalf("compaction lost context %+v", d)
	}
}
func TestAssistantCompactionFailureKeepsOldMemory(t *testing.T) {
	a := testApp(t)
	server := assistantFixture(t, a, func(string) (any, string) {
		return map[string]any{"memory": []MemoryItem{{Kind: "decision", Text: "伪造", Evidence: []string{"missing"}}}}, "stop"
	})
	d := &DraftAssistant{Memory: []MemoryItem{{Kind: "decision", Text: "原摘要", Evidence: []string{"old"}}}}
	for i := 0; i < 12; i++ {
		d.Messages = append(d.Messages, DraftMessage{ID: uid(), Role: "user", Text: strings.Repeat("历史", 500)})
	}
	e := a.compactDraft(context.Background(), AIConfig{APIKey: "test", BaseURL: server.URL, Model: "mimo-test"}, d)
	if e == nil || d.Compacted != 0 || d.Memory[0].Text != "原摘要" || len(d.Messages) != 12 {
		t.Fatal("bad summary overwrote memory")
	}
}
func TestAssistantSourceReadingAndRecycle(t *testing.T) {
	a, c, s, _ := seedAssistant(t)
	s = draftCall(t, a, c, s, "source", map[string]any{"source": DraftSource{Name: "syllabus", Parts: []SourcePart{{Location: "第1页", Text: "课程版本"}, {Location: "第2页", Text: "章节 A"}}}})
	src := s.Assistants["plan"].Sources[0]
	n := 0
	assistantFixture(t, a, func(raw string) (any, string) {
		n++
		if n == 1 {
			return map[string]any{"read": map[string]any{"sourceId": src.ID, "start": 2, "count": 1}}, "stop"
		}
		return map[string]any{"reply": "已读取第2页", "usedRefs": []string{src.Parts[1].ID}, "analysis": []AnalysisRow{{Topic: "A", Status: "待诊断", Hours: 1, HoursHigh: 3, Basis: "暂定", Refs: []string{src.Parts[1].ID}}}}, "stop"
	})
	s = draftCall(t, a, c, s, "chat", map[string]any{"message": "读第2页"})
	if s.Assistants["plan"].Error != "" || len(s.Assistants["plan"].Analysis) != 1 || n != 2 {
		t.Fatal("source read failed", s.Assistants["plan"].Error)
	}
	if e := deletePlan(&s, "plan"); e != nil {
		t.Fatal(e)
	}
	if s.Assistants["plan"] != nil || s.DeletedPlans[0].Assistant == nil {
		t.Fatal("assistant not recycled")
	}
	if e := restoreDeletedPlan(&s, "plan"); e != nil {
		t.Fatal(e)
	}
	if len(s.Assistants["plan"].Sources) != 1 {
		t.Fatal("sources lost on restore")
	}
}
func TestAssistantSourceValidationAndPublicAddressBoundary(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fc00::1", "100.64.0.1", "198.18.0.1"} {
		if publicDraftIP(net.ParseIP(address)) {
			t.Error("private address allowed", address)
		}
	}
	if !publicDraftIP(net.ParseIP("1.1.1.1")) {
		t.Fatal("public blocked")
	}
	for _, u := range []string{"http://example.com", "file:///secret", "https://user:pass@example.com", "https://example.com:8443"} {
		if validSourceURL(u) == nil {
			t.Error("unsafe URL", u)
		}
	}
	src := DraftSource{Name: "扫描PDF"}
	if validateSource(&src) == nil {
		t.Fatal("empty source accepted")
	}
	src = DraftSource{Name: "test", Original: "fake", Parts: []SourcePart{{Text: "text"}}}
	if validateSource(&src) == nil {
		t.Fatal("invalid original accepted")
	}
}

func TestAssistantGenericProjectsKeepSeparateContext(t *testing.T) {
	a, c, s, user := seedAssistant(t)
	var e error
	s, e = a.update(user, s.Version, func(s *State) error {
		s.Plans[0].Title = "软件版本发布"
		s.Plans[0].Input.Goal.Detail = "软件版本发布"
		p := samplePlan()
		p.ID = "event"
		p.Status = "draft"
		p.Title = "交流活动筹备"
		p.Input.Goal.Detail = p.Title
		s.Plans = append(s.Plans, p)
		return nil
	})
	if e != nil {
		t.Fatal(e)
	}
	calls := 0
	assistantFixture(t, a, func(raw string) (any, string) {
		calls++
		if calls == 1 && !strings.Contains(raw, "软件版本发布") {
			t.Error("current project missing")
		}
		if calls == 2 && (strings.Contains(raw, "软件版本发布") || strings.Contains(raw, "版本发布专属限制")) {
			t.Error("other project context leaked")
		}
		return map[string]any{"reply": "请明确这个项目的交付标准。"}, "stop"
	})
	s = draftCall(t, a, c, s, "settings", map[string]any{"constraints": "版本发布专属限制"})
	s = draftCall(t, a, c, s, "chat", map[string]any{"message": "讨论本项目的关键风险"})
	w := call(t, a, "POST", "/api/assistant/chat", map[string]any{"version": s.Version, "planId": "event", "message": "讨论活动组织的关键风险"}, c)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	json.Unmarshal(w.Body.Bytes(), &s)
	if len(s.Assistants["plan"].Messages) != 2 || len(s.Assistants["event"].Messages) != 2 {
		t.Fatal("project conversations not independent")
	}
	if strings.Contains(draftSystem, "syllabus") || strings.Contains(draftSystem, "CIE") || strings.Contains(draftSystem, `"topic":"小节"`) {
		t.Fatal("specialized project defaults in generic assistant")
	}
}

func TestAssistantMissingSourcesRepairsInsteadOfSilentFailure(t *testing.T) {
	for _, repairSucceeds := range []bool{true, false} {
		t.Run(itoa(map[bool]int{true: 1, false: 2}[repairSucceeds]), func(t *testing.T) {
			a, c, s, _ := seedAssistant(t)
			calls := 0
			assistantFixture(t, a, func(raw string) (any, string) {
				calls++
				if calls == 2 && repairSucceeds {
					return map[string]any{"reply": "已理解你的目标。尚未读取你提到的需求文件，请先添加参考资料。", "analysis": []AnalysisRow{}, "plan": nil}, "stop"
				}
				return map[string]any{"reply": "已分析文件", "analysis": []AnalysisRow{{Topic: "需求", Hours: 1, HoursHigh: 2, Refs: []string{"invented-document"}}}}, "stop"
			})
			s = draftCall(t, a, c, s, "chat", map[string]any{"message": "请按我提到的需求文档完善这个项目"})
			d := s.Assistants["plan"]
			if calls != 2 || d.Error != "" || len(d.Messages) != 2 || d.Proposal != nil || len(d.Analysis) != 0 {
				t.Fatal("invalid citations caused silent failure or leaked into plan")
			}
			if !strings.Contains(d.Messages[1].Text, "尚未读取") {
				t.Fatal("missing-source explanation absent")
			}
		})
	}
}
