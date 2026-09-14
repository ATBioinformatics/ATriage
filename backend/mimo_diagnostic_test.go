package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// Explicit opt-in: uses saved credentials with synthetic tasks, never prints keys or user data.
func TestMiMoLiveDiagnostic(t *testing.T) {
	if os.Getenv("ATRIAGE_LIVE_DIAGNOSTIC") != "1" {
		t.Skip("manual diagnostic only")
	}
	db, err := sql.Open("sqlite", "file:data/atriage.db?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	key, err := os.ReadFile("data/atriage-secret.key")
	if err != nil {
		t.Fatal(err)
	}
	var nonce, encrypted []byte
	if err = db.QueryRow("SELECT nonce,encrypted FROM ai_configs ORDER BY verified_at DESC LIMIT 1").Scan(&nonce, &encrypted); err != nil {
		t.Fatal(err)
	}
	a := &App{secretKey: key}
	config, err := a.openConfig(nonce, encrypted)
	if err != nil {
		t.Fatal("cannot decrypt config")
	}
	t.Logf("Mode=%s Model=%s", config.Mode, config.Model)
	transport := &diagnosticTransport{t: t, key: config.APIKey}
	a.client = &http.Client{Transport: transport, Timeout: 90 * time.Second}
	if err := a.verifyMiMoAt(context.Background(), config); err != nil {
		t.Fatal(err)
	}
	s := State{Profile: Profile{Rule: "优先处理重要事项"}, Order: []string{"test-1"}, Tasks: []Task{{ID: "test-1", Title: "准备会议", Status: "open"}}}
	if os.Getenv("ATRIAGE_DIAGNOSTIC_SAVED_TASKS") == "1" {
		var saved string
		if err := db.QueryRow("SELECT u.state FROM users u JOIN ai_configs c ON c.user_id=u.id ORDER BY c.verified_at DESC LIMIT 1").Scan(&saved); err != nil { t.Fatal("cannot read saved state") }
		if err := json.Unmarshal([]byte(saved), &s); err != nil { t.Fatal("cannot decode saved state") }
		t.Logf("Testing saved active tasks: %d", len(s.Order))
	}
	result := a.suggest(context.Background(), s, config)
	t.Logf("sorting source=%s notice=%s", result.Source, result.Notice)
	if result.Source != "ai" {
		t.Fatal("live sorting failed")
	}
}

type diagnosticTransport struct {
	t   *testing.T
	key string
}

func (d *diagnosticTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		d.t.Log("network request failed")
		return resp, err
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	resp.Body = io.NopCloser(bytes.NewReader(data))
	var body struct {
		Error struct {
			Code    any    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	_ = json.Unmarshal(data, &body)
	message := strings.ReplaceAll(body.Error.Message, d.key, "[redacted]")
	if len(message) > 800 {
		message = message[:800]
	}
	d.t.Logf("HTTP=%d error=%v message=%s choices=%d", resp.StatusCode, body.Error.Code, message, len(body.Choices))
	for _, c := range body.Choices {
		d.t.Logf("finish=%s content_bytes=%d", c.FinishReason, len(c.Message.Content))
	}
	if err != nil {
		d.t.Logf("response body read failed: %v", err)
	}
	return resp, nil
}
