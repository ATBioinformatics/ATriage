package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAssistantPublicFetchLive(t *testing.T) {
	if os.Getenv("ATRIAGE_LIVE_DRAFT") != "1" {
		t.Skip("opt-in public network acceptance")
	}
	a, c, s, _ := seedAssistant(t)
	started := time.Now()
	w := call(t, a, "POST", "/api/assistant/fetch", map[string]any{"version": s.Version, "planId": "plan", "url": "https://www.cambridgeinternational.org/Images/664565-2025-2027-syllabus.pdf"}, c)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var response struct {
		Kind string `json:"kind"`
		Data string `json:"data"`
	}
	if e := json.Unmarshal(w.Body.Bytes(), &response); e != nil {
		t.Fatal(e)
	}
	b, e := base64.StdEncoding.DecodeString(response.Data)
	if e != nil || response.Kind != "pdf" || !strings.HasPrefix(string(b), "%PDF-") {
		t.Fatal("public source is not a complete PDF")
	}
	t.Logf("Public HTTPS source fetched %d PDF bytes in %.1fs", len(b), time.Since(started).Seconds())
}

// Explicit opt-in: read saved credentials locally, send only a public syllabus
// sample and synthetic planning input. All writes use testApp's temporary DB.
func TestAssistantLiveSyllabus(t *testing.T) {
	if os.Getenv("ATRIAGE_LIVE_DRAFT") != "1" {
		t.Skip("opt-in real model acceptance")
	}
	path, e := filepath.Abs("data/atriage.db")
	if e != nil {
		t.Fatal(e)
	}
	db, e := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro")
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	key, e := os.ReadFile("data/atriage-secret.key")
	if e != nil {
		t.Fatal("saved key unavailable")
	}
	saved := &App{db: db, secretKey: key}
	var user string
	if e = db.QueryRow("SELECT user_id FROM ai_configs LIMIT 1").Scan(&user); e != nil {
		t.Fatal("no saved AI configuration")
	}
	config, _, e := saved.config(user)
	if e != nil {
		t.Fatal("saved AI configuration unreadable")
	}
	sourceBytes, e := os.ReadFile("../.tmp/assistant-live-source.json")
	if e != nil {
		t.Fatal(e)
	}
	var source DraftSource
	if e = json.Unmarshal(sourceBytes, &source); e != nil {
		t.Fatal(e)
	}
	a, c, s, _ := seedAssistant(t)
	a.aiBase = config.BaseURL
	a.aiKey = config.APIKey
	a.aiModel = config.Model
	a.client = &http.Client{Timeout: 90 * time.Second}
	s = draftCall(t, a, c, s, "source", map[string]any{"source": source})
	s = draftCall(t, a, c, s, "settings", map[string]any{"constraints": "验收场景：9702 AS，2025—2027；目标独立授课；现有任务仅占位，可替换；当前物理基础待诊断。只分析提供的第16页，不声称覆盖全文。", "weeklyHours": 6})
	started := time.Now()
	s = draftCall(t, a, c, s, "chat", map[string]any{"message": "请基于所提供syllabus第16页，分别分析1.1、1.2、1.3三个小节的学习工作量范围和依据（不是官方规定学时），然后提出替换占位任务的完整行动路径草案；我亲自完成所有学习与备课任务。每个小节保留引用和任务映射。"})
	d := s.Assistants["plan"]
	if d.Error != "" {
		t.Fatal(d.Error)
	}
	if d.Proposal == nil {
		t.Logf("Reply: %s", d.Messages[len(d.Messages)-1].Text)
		t.Fatal("real model did not return a proposal")
	}
	covered := 0
	for _, prefix := range []string{"1.1", "1.2", "1.3"} {
		for _, row := range d.Proposal.Analysis {
			if strings.Contains(row.Topic, prefix) && len(row.Refs) > 0 && len(row.NodeIDs) > 0 {
				covered++
				break
			}
		}
	}
	if covered != 3 {
		t.Fatalf("covered %d/3 explicitly requested subsections", covered)
	}
	s = draftCall(t, a, c, s, "apply", map[string]any{"proposalId": d.Proposal.ID})
	if len(s.Tasks) != 0 {
		t.Fatal("proposal applied into execution without confirmation")
	}
	result, _ := json.MarshalIndent(map[string]any{"elapsedSeconds": time.Since(started).Seconds(), "coverage": "3/3 requested subsections on page 16 only", "plan": s.Plans[0], "analysis": d.Proposal.Analysis, "reply": d.Messages[len(d.Messages)-1].Text}, "", "  ")
	if e = os.WriteFile("../.tmp/assistant-live-result.json", result, 0600); e != nil {
		t.Fatal(e)
	}
	t.Logf("Real MiMo: 3/3 requested subsections cited and mapped; %d nodes; %.1fs; context %d bytes. No production plan modified.", len(s.Plans[0].Nodes), time.Since(started).Seconds(), d.ContextBytes)
	// Exercise actual summary generation and a subsequent summary update, with
	// authoritative constraints kept outside the model-authored historical memory.
	memory := &DraftAssistant{Constraints: "只做AS；排除A2；先诊断", WeeklyHours: 6, Locked: []string{"T1"}}
	for round := 0; round < 2; round++ {
		for i := 0; i < 8; i++ {
			message := "讨论备课策略：" + strings.Repeat("每个小节应保留学习目标、诊断任务与可检查产出。", 20)
			if i == 0 {
				message = "用户确认：此前每周8小时已作废，现在每周只有6小时。只做AS，排除A2，先诊断再补学。" + message
			}
			memory.Messages = append(memory.Messages, DraftMessage{ID: uid(), Role: "user", Text: message})
		}
		ctx, cancel := context.WithTimeout(context.Background(), 85*time.Second)
		err := a.compactDraft(ctx, config, memory)
		cancel()
		if err != nil {
			t.Fatal("real compaction:", err)
		}
	}
	if memory.Compactions < 2 || len(memory.Messages) != 16 || memory.WeeklyHours != 6 || memory.Constraints != "只做AS；排除A2；先诊断" {
		t.Fatal("real compaction changed authoritative memory")
	}
	memJSON, _ := json.Marshal(memory.Memory)
	if !strings.Contains(string(memJSON), "6") || !strings.Contains(string(memJSON), "AS") {
		t.Fatal("summary omitted core scope or capacity")
	}
	t.Logf("Real compaction: %d rounds, all 16 original messages retained, authoritative constraints/locks unchanged, summary %d bytes.", memory.Compactions, len(memJSON))
}
