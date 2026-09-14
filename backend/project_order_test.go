package main

import (
	"reflect"
	"testing"
)

func TestProjectRankingExcludesChildrenAndPreservesExecution(t *testing.T) {
	s := State{Plans: []Plan{{ID: "p1", Status: "accepted", SourceTaskID: "root", Title: "project"}, {ID: "p2", Status: "draft", Title: "draft"}}, Tasks: []Task{{ID: "root", Title: "original", Status: "open", Deadline: "2026-10-01", Priority: "high"}, {ID: "child", PlanID: "p1", Status: "open", Title: "private child"}}, Order: []string{"root", "child"}, GoalOrder: []string{"p2", "p1"}}
	before := append([]Task(nil), s.Tasks...)
	ranked := projectRankingState(s)
	if !reflect.DeepEqual(ranked.Order, []string{"p2", "p1"}) || len(ranked.Tasks) != 2 {
		t.Fatal(ranked)
	}
	if ranked.Tasks[0].Deadline != "2026-10-01" || ranked.Tasks[0].Priority != "high" {
		t.Fatal("lost project constraints")
	}
	if permutation([]string{"child", "p1"}, ranked) {
		t.Fatal("accepted child in project order")
	}
	if !reflect.DeepEqual(s.Tasks, before) || !reflect.DeepEqual(s.Order, []string{"root", "child"}) {
		t.Fatal("modified execution tasks")
	}
}

func TestProjectRankingIncludesUndecomposedTaskWithoutDeadline(t *testing.T) {
	s := State{Plans: []Plan{{ID: "p1", Status: "draft", Title: "planned"}}, Tasks: []Task{
		{ID: "standalone", Title: "no deadline project", Status: "open", Zone: "Asia/Shanghai"},
		{ID: "finished", Title: "finished", Status: "done"},
	}}
	ranked := projectRankingState(s)
	if !permutation([]string{"p1", "standalone"}, ranked) {
		t.Fatalf("project preview must include an open top-level task without a deadline: %#v", ranked)
	}
	if ranked.Tasks[1].Deadline != "" {
		t.Fatal("the missing deadline must remain missing for the AI to assess")
	}
}
