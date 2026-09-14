package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

func purgeDeletedPlan(s *State, id, directory string) error {
	for i, entry := range s.DeletedPlans {
		if entry.Plan.ID != id {
			continue
		}
		data, err := json.Marshal(entry)
		if err != nil {
			return err
		}
		if err = os.MkdirAll(directory, 0700); err != nil {
			return errors.New("无法保存恢复备份，未执行永久删除")
		}
		// Random names prevent user-controlled IDs from becoming filesystem paths.
		if err = os.WriteFile(filepath.Join(directory, uid()+".json"), data, 0600); err != nil {
			return errors.New("无法保存恢复备份，未执行永久删除")
		}
		s.DeletedPlans = append(s.DeletedPlans[:i], s.DeletedPlans[i+1:]...)
		return nil
	}
	return errors.New("回收站中没有此目标")
}

// The account recycle bin retains the full plan and execution records.
type DeletedPlan struct {
	Assistant  *DraftAssistant `json:"assistant,omitempty"`
	Standalone bool            `json:"standalone,omitempty"`
	Plan       Plan            `json:"plan"`
	Tasks      []Task          `json:"tasks"`
}

func deletePlan(s *State, id string) error {
	index := -1
	for i, p := range s.Plans {
		if p.ID == id {
			index = i
		}
	}
	var p Plan
	if index >= 0 {
		p = s.Plans[index]
	} else {
		for _, task := range s.Tasks {
			if task.ID == id && task.PlanID == "" {
				for _, existing := range s.Plans {
					if existing.SourceTaskID == id {
						return errors.New("请从关联目标计划删除")
					}
				}
				p = Plan{ID: id, SourceTaskID: id, Title: task.Title}
			}
		}
		if p.ID == "" {
			return errors.New("目标不存在或不属于当前账号")
		}
	}
	removed := map[string]bool{}
	entry := DeletedPlan{Plan: p, Standalone: index < 0}
	entry.Assistant = s.Assistants[id]
	for _, task := range s.Tasks {
		if task.PlanID == id || task.ID == p.SourceTaskID {
			removed[task.ID] = true
			entry.Tasks = append(entry.Tasks, task)
		}
	}
	for _, task := range s.Tasks {
		if removed[task.ID] {
			continue
		}
		for _, dep := range task.Dependencies {
			if removed[dep] {
				return errors.New("其他目标仍依赖此项目的任务，请先调整依赖")
			}
		}
	}
	tasks := []Task{}
	for _, task := range s.Tasks {
		if !removed[task.ID] {
			tasks = append(tasks, task)
		}
	}
	order := []string{}
	for _, taskID := range s.Order {
		if !removed[taskID] {
			order = append(order, taskID)
		}
	}
	goals := []string{}
	for _, goalID := range s.GoalOrder {
		if goalID != id && !removed[goalID] {
			goals = append(goals, goalID)
		}
	}
	s.Tasks, s.Order, s.GoalOrder = tasks, order, goals
	s.DeletedPlans = append(s.DeletedPlans, entry)
	delete(s.Assistants, id)
	if index >= 0 {
		s.Plans = append(s.Plans[:index], s.Plans[index+1:]...)
	}
	return nil
}

func restoreDeletedPlan(s *State, id string) error {
	for i, entry := range s.DeletedPlans {
		if entry.Plan.ID != id {
			continue
		}
		open := 0
		for _, task := range entry.Tasks {
			if task.Status == "open" {
				open++
			}
		}
		if (!entry.Standalone && len(s.Plans) >= 50) || len(s.Tasks)+len(entry.Tasks) > 2000 || len(s.Order)+open > 200 {
			return errors.New("恢复后将超过容量限制，请先整理当前任务")
		}
		if !entry.Standalone {
			s.Plans = append(s.Plans, entry.Plan)
		}
		if entry.Assistant != nil {
			if s.Assistants == nil {
				s.Assistants = map[string]*DraftAssistant{}
			}
			s.Assistants[id] = entry.Assistant
		}
		s.Tasks = append(s.Tasks, entry.Tasks...)
		for _, task := range entry.Tasks {
			if task.Status == "open" {
				s.Order = append(s.Order, task.ID)
			}
		}
		s.GoalOrder = append(s.GoalOrder, id)
		s.DeletedPlans = append(s.DeletedPlans[:i], s.DeletedPlans[i+1:]...)
		return nil
	}
	return errors.New("回收站中没有此目标")
}
