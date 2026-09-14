package main

import "testing"

func TestPLevelIndependentOfDelegation(t *testing.T) {
	for _, level := range []string{"", "P0", "P1", "P2", "P3"} {
		p := samplePlan()
		p.Nodes[0].PLevel = level
		p.Nodes[0].Mode = "delegate"
		if err := schedulePlan(&p); err != nil {
			t.Fatal(err)
		}
		if p.Nodes[0].PLevel != level || p.Nodes[0].Mode != "delegate" {
			t.Fatal("priority and execution mode must remain independent")
		}
	}
	p := samplePlan()
	p.Nodes[0].PLevel = "P4"
	if schedulePlan(&p) == nil {
		t.Fatal("invalid P level accepted")
	}
	task := Task{Title: "执行任务", PLevel: "P0"}
	if validateTask(task) != nil {
		t.Fatal("valid task rejected")
	}
	task.PLevel = "urgent"
	if validateTask(task) == nil {
		t.Fatal("invalid task P level accepted")
	}
}
