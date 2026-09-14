package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestPurgeBacksUpBeforeRemoving(t *testing.T) {
	entry := DeletedPlan{Plan: Plan{ID: "p", Title: "保留备份"}, Tasks: []Task{{ID: "t", Deadline: "2026-10-15"}}}
	s := State{DeletedPlans: []DeletedPlan{entry}}
	dir := t.TempDir()
	if err := purgeDeletedPlan(&s, "p", dir); err != nil {
		t.Fatal(err)
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 1 || len(s.DeletedPlans) != 0 {
		t.Fatal("purge failed")
	}
	data, _ := os.ReadFile(filepath.Join(dir, files[0].Name()))
	var recovered DeletedPlan
	if json.Unmarshal(data, &recovered) != nil || !reflect.DeepEqual(entry, recovered) {
		t.Fatal("backup incomplete")
	}
	s.DeletedPlans = []DeletedPlan{entry}
	if purgeDeletedPlan(&s, "p", filepath.Join(dir, files[0].Name(), "invalid")) == nil || len(s.DeletedPlans) != 1 {
		t.Fatal("deleted without backup")
	}
}

func TestDeleteRestoreUndecomposedGoal(t *testing.T) {
	original := Task{ID: "fourth", Title: "培训校区职员", Status: "open", Deadline: "2026-09-30"}
	s := State{Tasks: []Task{original}, Order: []string{"fourth"}, GoalOrder: []string{"fourth"}}
	if err := deletePlan(&s, "fourth"); err != nil {
		t.Fatal(err)
	}
	if len(projectRankingState(s).Tasks) != 0 || len(s.DeletedPlans) != 1 {
		t.Fatal("goal not removed")
	}
	if err := restoreDeletedPlan(&s, "fourth"); err != nil {
		t.Fatal(err)
	}
	if len(s.Plans) != 0 || !reflect.DeepEqual(s.Tasks, []Task{original}) || !permutation([]string{"fourth"}, projectRankingState(s)) {
		t.Fatal("restore changed goal", s)
	}
}

func TestDeleteRestorePlanRetainsExecution(t *testing.T) {
	for _, status := range []string{"draft", "accepted"} {
		s := State{Plans: []Plan{{ID: "p", SourceTaskID: "root", Status: status}}, Tasks: []Task{{ID: "root", Status: "open"}, {ID: "child", PlanID: "p", Status: "done", Deadline: "2026-10-15"}, {ID: "other", Status: "open"}}, Order: []string{"root", "other"}, GoalOrder: []string{"p", "other"}}
		original := append([]Task(nil), s.Tasks[:2]...)
		if err := deletePlan(&s, "p"); err != nil {
			t.Fatal(err)
		}
		if len(s.Plans) != 0 || len(s.Tasks) != 1 || !permutation([]string{"other"}, projectRankingState(s)) {
			t.Fatal("deleted goal remains visible", s)
		}
		if err := restoreDeletedPlan(&s, "p"); err != nil {
			t.Fatal(err)
		}
		if len(s.DeletedPlans) != 0 || !reflect.DeepEqual(s.Tasks[1:], original) || s.Plans[0].Status != status {
			t.Fatal("execution was lost", s)
		}
	}
}

func TestDeletePlanRejectsExternalDependency(t *testing.T) {
	s := State{Plans: []Plan{{ID: "p"}}, Tasks: []Task{{ID: "child", PlanID: "p"}, {ID: "other", Dependencies: []string{"child"}}}}
	if deletePlan(&s, "p") == nil || len(s.Plans) != 1 || len(s.Tasks) != 2 {
		t.Fatal("external dependency was broken")
	}
}
