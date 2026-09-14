package main

import (
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// Isolated UI fixture. Never writes to the user's production account or database.
func TestAssistantBrowser(t *testing.T) {
	if os.Getenv("ATRIAGE_ASSISTANT_BROWSER") != "1" {
		t.Skip("opt-in browser fixture")
	}
	a, c, s, user := seedAssistant(t)
	next := hourlyPlan(s.Plans[0])
	next.Title = "产品发布准备（功能演示）"
	next.Nodes[0].Title = "核对需求与验收标准"
	next.Nodes[0].Deliverable = "需求与投入分析表"
	assistantFixture(t, a, func(string) (any, string) {
		if os.Getenv("ATRIAGE_ASSISTANT_SLOW") == "1" {
			time.Sleep(15 * time.Second)
		}
		return map[string]any{"reply": "建议先核对需求与验收标准，再估算各环节投入。以下修改先供检查，应用后更新草案。", "plan": next}, "stop"
	})
	_, e := a.update(user, s.Version, func(s *State) error {
		s.Profile.Onboarded = true
		s.Profile.Name = "功能演示（模拟AI）"
		s.Plans[0].Title = "产品发布准备（功能演示）"
		_, d, _ := draftState(s, "plan")
		d.Constraints = "月底交付可用首版；不增加预算"
		d.WeeklyHours = 6
		return nil
	})
	if e != nil {
		t.Fatal(e)
	}
	dist := http.FileServer(http.Dir("../frontend/dist"))
	server := &http.Server{Addr: "127.0.0.1:8094", Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			r.Header.Del("Cookie")
			r.AddCookie(c)
			a.ServeHTTP(w, r)
		} else {
			dist.ServeHTTP(w, r)
		}
	})}
	go server.ListenAndServe()
	defer server.Close()
	t.Log("UI fixture http://127.0.0.1:8094, local mock AI")
	timer := time.NewTimer(20 * time.Minute)
	defer timer.Stop()
	<-timer.C
}
