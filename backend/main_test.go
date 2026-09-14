package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testApp(t *testing.T) *App {
	t.Helper()
	a, e := openApp(filepath.Join(t.TempDir(), "test.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { a.db.Close() })
	a.aiBase = ""
	return a
}
func call(t *testing.T, a *App, method, path string, body any, c *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	r := httptest.NewRequest(method, path, bytes.NewReader(b))
	r.Header.Set("Content-Type", "application/json")
	if c != nil {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	return w
}
func register(t *testing.T, a *App, email string) (*http.Cookie, State) {
	t.Helper()
	w := call(t, a, "POST", "/api/register", map[string]string{"email": email, "password": "correct-horse-42", "name": "测试用户", "zone": "Asia/Shanghai"}, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var s State
	json.Unmarshal(w.Body.Bytes(), &s)
	return w.Result().Cookies()[0], s
}
func create(t *testing.T, a *App, c *http.Cookie, s State, title, p string) (State, string) {
	t.Helper()
	w := call(t, a, "POST", "/api/tasks", map[string]any{"version": s.Version, "task": Task{Title: title, Priority: p}}, c)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var v struct {
		State  State  `json:"state"`
		TaskID string `json:"taskId"`
	}
	json.Unmarshal(w.Body.Bytes(), &v)
	return v.State, v.TaskID
}
func TestAccountsIsolationPersistenceAndLogout(t *testing.T) {
	a := testApp(t)
	c, s := register(t, a, "one@example.com")
	s, id := create(t, a, c, s, "期末复核", "low")
	other, os := register(t, a, "two@example.com")
	foreign := s.Tasks[0]
	foreign.Title = "非法修改"
	w := call(t, a, "PUT", "/api/tasks", map[string]any{"version": os.Version, "task": foreign}, other)
	if w.Code != 400 {
		t.Fatal("cross account write", w.Code)
	}
	w = call(t, a, "GET", "/api/state", nil, other)
	if strings.Contains(w.Body.String(), id) {
		t.Fatal("data leaked")
	}
	w = call(t, a, "POST", "/api/login", map[string]string{"email": "one@example.com", "password": "wrong-pass"}, nil)
	if w.Code != 401 {
		t.Fatal("bad password accepted")
	}
	w = call(t, a, "POST", "/api/login", map[string]string{"email": "one@example.com", "password": "correct-horse-42"}, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), id) {
		t.Fatal("login persistence", w.Body.String())
	}
	w = call(t, a, "POST", "/api/logout", map[string]any{}, c)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	if call(t, a, "GET", "/api/state", nil, c).Code != 401 {
		t.Fatal("session not revoked")
	}
	// A separate database connection simulates server restart without relying on browser state.
	var path string
	var seq int
	var name string
	a.db.QueryRow("PRAGMA database_list").Scan(&seq, &name, &path)
	b, e := openApp(path)
	if e != nil {
		t.Fatal(e)
	}
	defer b.db.Close()
	w = call(t, b, "POST", "/api/login", map[string]string{"email": "one@example.com", "password": "correct-horse-42"}, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), id) {
		t.Fatal("restart persistence")
	}
}
func TestOrderVersionsInsertionAndRestore(t *testing.T) {
	a := testApp(t)
	c, s := register(t, a, "a@example.com")
	s, x := create(t, a, c, s, "A", "low")
	s, y := create(t, a, c, s, "B", "high")
	w := call(t, a, "PUT", "/api/order", map[string]any{"version": s.Version, "order": []string{x, y}}, c)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	json.Unmarshal(w.Body.Bytes(), &s)
	s, z := create(t, a, c, s, "C", "high")
	pos := map[string]int{}
	for i, id := range s.Order {
		pos[id] = i
	}
	if pos[x] > pos[y] {
		t.Fatal("manual relative order changed")
	}
	w = call(t, a, "PUT", "/api/order", map[string]any{"version": s.Version - 1, "order": s.Order}, c)
	if w.Code != 409 {
		t.Fatal("stale write accepted")
	}
	w = call(t, a, "PUT", "/api/order", map[string]any{"version": s.Version, "order": []string{x, x, z}}, c)
	if w.Code != 400 {
		t.Fatal("duplicate order accepted")
	}
	for _, status := range []string{"skipped", "open", "done", "open"} {
		task := s.Tasks[0]
		task.Status = status
		w = call(t, a, "PUT", "/api/tasks", map[string]any{"version": s.Version, "task": task}, c)
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		var out struct {
			State State `json:"state"`
		}
		json.Unmarshal(w.Body.Bytes(), &out)
		s = out.State
		if s.Tasks[0].Status != status {
			t.Fatal("status not saved")
		}
		if status == "open" && s.Order[len(s.Order)-1] != x {
			t.Fatal("restore must append")
		}
	}
}
func TestDeadlineZones(t *testing.T) {
	d, e := deadline(Task{Deadline: "2026-09-13", Zone: "Asia/Shanghai"})
	if e != nil || d.UTC().Format(time.RFC3339Nano) != "2026-09-13T15:59:59.999999999Z" {
		t.Fatal(d, e)
	}
	d, e = deadline(Task{Deadline: "2026-09-13T09:30", Zone: "Asia/Shanghai"})
	if e != nil || d.UTC().Format(time.RFC3339) != "2026-09-13T01:30:00Z" {
		t.Fatal(d, e)
	}
	for _, tt := range []Task{{Deadline: "not-date", Zone: "Asia/Shanghai"}, {Deadline: "2026-09-13", Zone: "fake"}} {
		if _, e := deadline(tt); e == nil {
			t.Fatal("invalid accepted")
		}
	}
}
func aiServer(t *testing.T, reply func()) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reply()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": `{"order":["a"],"priorities":{"a":"low"},"reasons":{"a":"人工指定为低；背景有限。"}}`}}}})
	}))
}
func TestAIValidationAndFallback(t *testing.T) {
	a := testApp(t)
	s := State{Order: []string{"a"}, Tasks: []Task{{ID: "a", Title: "A", Status: "open", Priority: "low"}}}
	v := a.suggest(context.Background(), s, AIConfig{})
	if v.Source != "basic" {
		t.Fatal("missing config")
	}
	server := aiServer(t, func() {})
	defer server.Close()
	a.aiBase = server.URL
	a.aiKey = "test"
	a.aiModel = "test"
	v = a.suggest(context.Background(), s, AIConfig{APIKey: a.aiKey, BaseURL: a.aiBase, Model: a.aiModel})
	if v.Source != "ai" || v.Priorities["a"] != "low" {
		t.Fatal(v)
	}
	s.Tasks[0].Priority = "high"
	if a.suggest(context.Background(), s, AIConfig{APIKey: a.aiKey, BaseURL: a.aiBase, Model: a.aiModel}).Source != "basic" {
		t.Fatal("AI override accepted")
	}
	s.Tasks[0].ID = "b"
	s.Order = []string{"b"}
	if a.suggest(context.Background(), s, AIConfig{APIKey: a.aiKey, BaseURL: a.aiBase, Model: a.aiModel}).Source != "basic" {
		t.Fatal("foreign task accepted")
	}
	a.client.Timeout = time.Nanosecond
	if a.suggest(context.Background(), s, AIConfig{APIKey: a.aiKey, BaseURL: a.aiBase, Model: a.aiModel}).Source != "basic" {
		t.Fatal("timeout fallback")
	}
}

func TestMiMoKeyConfigurationIsEncryptedAndIsolated(t *testing.T) {
	a := testApp(t)
	first, _ := register(t, a, "mimo-one@example.com")
	second, _ := register(t, a, "mimo-two@example.com")
	firstID, e := a.user(httptest.NewRequest("GET", "/", nil))
	if e == nil || firstID != "" {
		t.Fatal("request without cookie should not authenticate")
	}
	request := httptest.NewRequest("GET", "/", nil)
	request.AddCookie(first)
	firstID, e = a.user(request)
	if e != nil {
		t.Fatal(e)
	}
	config, e := mimoForKey("sk-secret-value")
	if e != nil {
		t.Fatal(e)
	}
	if e = a.saveConfig(firstID, config); e != nil {
		t.Fatal(e)
	}
	stored, status, e := a.config(firstID)
	if e != nil || !status.Configured || stored.APIKey != "sk-secret-value" || stored.BaseURL != "https://api.xiaomimimo.com/v1" {
		t.Fatal(stored, status, e)
	}
	var sealed []byte
	if e = a.db.QueryRow("SELECT encrypted FROM ai_configs WHERE user_id=?", firstID).Scan(&sealed); e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(sealed, []byte("sk-secret-value")) {
		t.Fatal("key stored in plaintext")
	}
	request = httptest.NewRequest("GET", "/", nil)
	request.AddCookie(second)
	secondID, e := a.user(request)
	if e != nil {
		t.Fatal(e)
	}
	_, status, e = a.config(secondID)
	if e != nil || status.Configured {
		t.Fatal("configuration leaked between users")
	}
	plan, e := mimoForKey("tp-plan-value")
	if e != nil || plan.BaseURL != "https://token-plan-cn.xiaomimimo.com/v1" || plan.Mode != "Token Plan" {
		t.Fatal(plan, e)
	}
	if _, e = mimoForKey("not-a-mimo-key"); e == nil {
		t.Fatal("invalid key accepted")
	}
}

func TestMiMoVerificationUsesBothCompatibleHeaders(t *testing.T) {
	a := testApp(t)
	var received bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer sk-check" || r.Header.Get("api-key") != "sk-check" {
			t.Fatal("MiMo request is not compatible")
		}
		received = true
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": "OK"}}}})
	}))
	defer server.Close()
	config := AIConfig{APIKey: "sk-check", BaseURL: server.URL, Model: "mimo-v2.5-pro"}
	if e := a.verifyMiMo(context.Background(), &config); e != nil {
		t.Fatal(e)
	}
	if !received {
		t.Fatal("verification did not call API")
	}
	server.Close()
	if e := a.verifyMiMo(context.Background(), &config); e == nil {
		t.Fatal("connection failure accepted")
	}
}
func TestMiMoRejectsEmptyAndTruncatedVerification(t *testing.T) {
	a := testApp(t)
	for _, result := range []string{
		`{"choices":[{"message":{"content":""},"finish_reason":"length"}]}`,
		`{"choices":[{"message":{"content":"OK"},"finish_reason":"length"}]}`,
		`{"choices":[]}`,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(result))
		}))
		err := a.verifyMiMoAt(context.Background(), AIConfig{BaseURL: server.URL, Model: "mimo-v2.5-pro"})
		server.Close()
		if err == nil {
			t.Fatal("invalid verification accepted", result)
		}
	}
}
func TestAITimeoutIsIdentified(t *testing.T) {
	if !strings.Contains(aiFailure(200, context.DeadlineExceeded), "超时") {
		t.Fatal("response read timeout was hidden")
	}
}
func TestLateAISuggestionCannotOverwriteManualChange(t *testing.T) {
	a := testApp(t)
	c, s := register(t, a, "race@example.com")
	s, id := create(t, a, c, s, "A", "low")
	started := make(chan bool)
	release := make(chan bool)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started <- true
		<-release
		data := Suggestion{Order: []string{id}, Priorities: map[string]string{id: "low"}, Reasons: map[string]string{id: "低重要程度"}}
		b, _ := json.Marshal(data)
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(b)}}}})
	}))
	defer server.Close()
	a.aiBase = server.URL
	a.aiKey = "test"
	a.aiModel = "test"
	done := make(chan *httptest.ResponseRecorder)
	go func() {
		done <- call(t, a, "POST", "/api/suggest", map[string]any{"version": s.Version, "taskId": id}, c)
	}()
	<-started
	w := call(t, a, "PUT", "/api/order", map[string]any{"version": s.Version, "order": s.Order}, c)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	release <- true
	w = <-done
	if !strings.Contains(w.Body.String(), `"applied":false`) {
		t.Fatal("stale AI applied", w.Body.String())
	}
}
func TestCSRFAndInputValidation(t *testing.T) {
	a := testApp(t)
	c, s := register(t, a, "secure@example.com")
	r := httptest.NewRequest("POST", "http://localhost/api/tasks", strings.NewReader(`{}`))
	r.Header.Set("Origin", "https://evil.example")
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(c)
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("origin not checked")
	}
	w = call(t, a, "POST", "/api/tasks", map[string]any{"version": s.Version, "task": Task{Title: " "}}, c)
	if w.Code != 400 {
		t.Fatal("empty task accepted")
	}
}
