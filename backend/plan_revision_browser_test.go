package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// Opt-in fixture: disposable account and a local fake model, never the real DB.
func TestPlanRevisionBrowser(t *testing.T) {
	if os.Getenv("ATRIAGE_REVISION_BROWSER") != "1" {
		t.Skip("manual isolated UI acceptance")
	}
	a := testApp(t)
	cookie, s := register(t, a, "revision-browser@example.com")
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		json.NewDecoder(r.Body).Decode(&request)
		var input struct {
			UserNodes []PlanNode `json:"userNodes"`
		}
		json.Unmarshal([]byte(request.Messages[1].Content), &input)
		p := samplePlan()
		if len(input.UserNodes) > 0 {
			p.Nodes = input.UserNodes
			for i := range p.Nodes {
				p.Nodes[i].Days = 2
				p.Nodes[i].WaitDays = 0
				p.Nodes[i].DependsOn = []string{}
				if i > 0 {
					p.Nodes[i].DependsOn = []string{p.Nodes[i-1].ID}
				}
			}
		}
		raw, _ := json.Marshal(p)
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": string(raw)}}}})
	}))
	defer model.Close()
	a.aiBase, a.aiKey, a.aiModel = model.URL, "fixture", "mimo-test"
	var id string
	if err := a.db.QueryRow("SELECT id FROM users WHERE email=?", "revision-browser@example.com").Scan(&id); err != nil {
		t.Fatal(err)
	}
	s, err := a.update(id, s.Version, func(s *State) error {
		s.Profile.Onboarded = true
		s.Profile.Name = "编排流程验收"
		s.Profile.Role = "Principal"
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	s = decodePlanState(t, call(t, a, "POST", "/api/plans/generate", map[string]any{"version": s.Version, "input": PlanInput{Goal: PlanField{Detail: "反馈试点"}}}, cookie))
	decodePlanState(t, call(t, a, "POST", "/api/plans/accept", map[string]any{"version": s.Version, "planId": s.Plans[0].ID}, cookie))
	dist := http.FileServer(http.Dir("../frontend/dist"))
	server := &http.Server{Addr: "127.0.0.1:8094", Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			r.Header.Del("Cookie")
			r.AddCookie(cookie)
			a.ServeHTTP(w, r)
		} else {
			dist.ServeHTTP(w, r)
		}
	})}
	go server.ListenAndServe()
	defer server.Close()
	t.Log("Isolated revision UI fixture http://127.0.0.1:8094 (local mock AI)")
	time.Sleep(10 * time.Minute)
}
