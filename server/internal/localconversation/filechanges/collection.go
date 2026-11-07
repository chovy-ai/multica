package filechanges

// Collection is deferred work on the conversation's ordered batch flush, never
// on a provider's stdio reader or the global SQLite writer.
type Collection struct {
	Capture *Capture
	TurnID  string
	Native  []NativeChange
	Unknown bool
	Run     func() []Observation
	Bytes   int
}
type NativeChange struct {
	OperationID, Path, MovePath, Kind, Patch string
	Success                                  bool
}

func Collect(work []Collection) []Observation {
	var out []Observation
	for i := 0; i < len(work); {
		c := work[i]
		if c.Run != nil {
			out = append(out, c.Run()...)
			i++
			continue
		}
		if c.Capture == nil {
			i++
			continue
		}
		if c.Unknown {
			out = append(out, c.Capture.Unknown(c.TurnID)...)
			out = append(out, Observation{OperationID: "capture-end:" + c.TurnID, TurnID: c.TurnID})
			i++
			continue
		}
		native := append([]NativeChange(nil), c.Native...)
		i++
		for i < len(work) && work[i].Capture == c.Capture && !work[i].Unknown && work[i].Run == nil {
			native = append(native, work[i].Native...)
			i++
		}
		out = append(out, c.Capture.NativeBatch(c.TurnID, native)...)
	}
	return out
}

// NativeBatch composes contiguous native patches before checking disk. A later
// edit already on disk must not make an earlier successful patch look external.
func (c *Capture) NativeBatch(turn string, changes []NativeChange) []Observation {
	c.mu.Lock()
	defer c.mu.Unlock()
	virtual := map[string]Snapshot{}
	for path, s := range c.Files {
		virtual[path] = s
	}
	before := func(path string) Snapshot {
		if s, ok := virtual[path]; ok {
			return s
		}
		if c.Complete {
			return Snapshot{Hash: Hash("")}
		}
		return Snapshot{Reason: "missing_baseline"}
	}
	out := make([]Observation, 0, len(changes))
	lineages := map[string]int{}
	touched := map[string]int{}
	groups := make([]int, 0, len(changes))
	invalid := map[int]bool{}
	for _, n := range changes {
		path, reason := Relative(c.Root, n.Path)
		group, ok := lineages[path]
		if !ok {
			group = len(changes) + len(out)
			lineages[path] = group
		}
		o := Observation{OperationID: n.OperationID, TurnID: turn, Cwd: c.Root, Path: path, Reason: reason}
		target := path
		if n.MovePath != "" {
			var moveReason string
			target, moveReason = Relative(c.Root, n.MovePath)
			if o.Reason == "" {
				o.Reason = moveReason
			}
			o.MovePath = target
		}
		o.Before = before(path)
		o.After = o.Before
		if o.Reason == "" {
			o.Reason = o.Before.Reason
		}
		if o.Reason == "" {
			noWrite := false
			if !n.Success {
				actual := Read(c.Root, path)
				noWrite = actual.Reason == "" && actual.Hash == o.Before.Hash && actual.Exists == o.Before.Exists
				if noWrite && target != path {
					previousTarget, actualTarget := before(target), Read(c.Root, target)
					noWrite = previousTarget.Reason == "" && actualTarget.Reason == "" && actualTarget.Hash == previousTarget.Hash && actualTarget.Exists == previousTarget.Exists
				}
			}
			if noWrite {
				// A failed operation did not move or create a file when both paths
				// still match their snapshots. Preserve existence as well as bytes.
				target, o.MovePath = path, ""
			} else {
				text, valid := Apply(o.Before.Content, n.Patch, n.Kind)
				if !valid {
					o.Reason = "uncertain"
				} else {
					o.After = Snapshot{Exists: n.Kind != "delete", Content: text, Hash: Hash(text)}
				}
			}
		}
		if o.Reason != "" {
			invalid[group] = true
		} else {
			if path != target {
				virtual[path] = Snapshot{Hash: Hash("")}
				delete(lineages, path)
			}
			virtual[target] = o.After
			lineages[target] = group
		}
		touched[path], touched[target] = group, group
		groups = append(groups, group)
		out = append(out, o)
	}
	for path, group := range touched {
		expected := virtual[path]
		actual := Read(c.Root, path)
		if actual.Reason != "" || actual.Hash != expected.Hash || actual.Exists != expected.Exists {
			invalid[group] = true
		}
	}
	for i := range out {
		o := &out[i]
		target := o.Path
		if o.MovePath != "" {
			target = o.MovePath
		}
		if invalid[groups[i]] && o.Reason == "" {
			o.Reason = "uncertain"
		}
		if o.Reason == "" {
			delete(c.Files, o.Path)
			c.Files[target] = o.After
			if o.MovePath == "" && o.Before.Hash == o.After.Hash && o.Before.Exists == o.After.Exists {
				o.Path = ""
			}
		}
	}
	return out
}
