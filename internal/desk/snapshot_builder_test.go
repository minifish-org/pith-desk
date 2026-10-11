package desk

import (
	"testing"
	"time"
)

func TestSnapshotBuilderTimingDoesNotChangeOwner(t *testing.T) {
	now := time.Date(2026, 10, 11, 0, 0, 2, 0, time.UTC)
	selected := ConversationState{Runtime: RuntimeStatus{Timing: TaskTiming{ElapsedMs: 42}}}
	builder := SnapshotBuilder{}
	for _, tc := range []struct {
		name    string
		started time.Time
		want    int64
	}{
		{"live task", now.Add(-1500 * time.Millisecond), 1500},
		{"saved checkpoint", time.Time{}, 42},
	} {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := builder.build(snapshotSources{selected: selected, runStarted: tc.started}, now)
			if snapshot.Runtime.Timing.ElapsedMs != tc.want || selected.Runtime.Timing.ElapsedMs != 42 {
				t.Fatalf("projection changed timing semantics: snapshot=%d owner=%d", snapshot.Runtime.Timing.ElapsedMs, selected.Runtime.Timing.ElapsedMs)
			}
		})
	}
}
