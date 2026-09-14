package main

import (
	"database/sql"
	"encoding/json"
	"os"
	"testing"
)

func TestPlanSourceIdentity(t *testing.T) {
	s := State{Tasks: []Task{{ID: "t", Title: "goal"}}, Plans: []Plan{{ID: "p", Input: PlanInput{Goal: PlanField{Detail: "goal"}}}}}
	linkPlanSources(&s)
	if s.Plans[0].SourceTaskID != "t" {
		t.Fatal("missing unique source")
	}
	s.Tasks[0].Title = "renamed"
	linkPlanSources(&s)
	if s.Plans[0].SourceTaskID != "t" {
		t.Fatal("lost stable identity")
	}
	s.Plans[0].SourceTaskID = ""
	s.Tasks[0].Title = "goal"
	s.Tasks = append(s.Tasks, Task{ID: "t2", Title: "goal"})
	linkPlanSources(&s)
	if s.Plans[0].SourceTaskID != "" {
		t.Fatal("ambiguous tasks linked")
	}
	s.Tasks = s.Tasks[:1]
	s.Plans = append(s.Plans, Plan{ID: "p2", Input: s.Plans[0].Input})
	linkPlanSources(&s)
	if s.Plans[0].SourceTaskID != "" || s.Plans[1].SourceTaskID != "" {
		t.Fatal("ambiguous plans linked")
	}
}

func TestExportGoalViewReadOnly(t *testing.T) {
	if os.Getenv("ATRIAGE_GOAL_VIEW") != "1" {
		t.Skip("optional local read-only UI check")
	}
	db, err := sql.Open("sqlite", "file:data/atriage.db?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var raw string
	if err = db.QueryRow("SELECT state FROM users WHERE json_extract(state, '$.profile.name') = ?", "Michael").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var s State
	if err = json.Unmarshal([]byte(raw), &s); err != nil {
		t.Fatal(err)
	}
	linkPlanSources(&s)
	for _, p := range s.Plans {
		t.Logf("%s status=%s linked=%t", p.Title, p.Status, p.SourceTaskID != "")
	}
	s.Profile.Name = "目标只读验收"
	s.Profile.Rule = ""
	s.Profile.Goals = []string{}
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile("../.tmp/goal-state.json", b, 0600); err != nil {
		t.Fatal(err)
	}
}
