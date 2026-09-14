package main

// The ranking model receives one record per visible project, never its tasks.
func projectRankingState(s State) State {
	out := State{Profile: s.Profile, Tasks: []Task{}, Order: []string{}}
	for _, p := range s.Plans {
		var source Task
		open := p.Status == "draft"
		for _, t := range s.Tasks {
			if t.ID == p.SourceTaskID {
				source = t
				open = open || t.Status == "open"
			}
			if t.PlanID == p.ID && t.Status == "open" {
				open = true
			}
		}
		if !open {
			continue
		}
		t := Task{ID: p.ID, Title: p.Title, Notes: p.Summary, Status: "open", Created: p.Created, Zone: s.Profile.Zone, Priority: source.Priority, Deadline: source.Deadline}
		if source.Title != "" {
			t.Title = source.Title
		}
		out.Tasks = append(out.Tasks, t)
	}
	seen := map[string]bool{}
	for _, id := range s.GoalOrder {
		for _, t := range out.Tasks {
			if t.ID == id && !seen[id] {
				out.Order = append(out.Order, id)
				seen[id] = true
			}
		}
	}
	for _, t := range out.Tasks {
		if !seen[t.ID] {
			out.Order = append(out.Order, t.ID)
		}
	}
	return out
}
