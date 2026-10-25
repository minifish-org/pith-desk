package desk

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"
)

func BenchmarkSnapshotAndJSON(b *testing.B) {
	for _, count := range []int{100, 1000} {
		b.Run(strconv.Itoa(count)+"-messages", func(b *testing.B) {
			messages := make([]Message, count)
			for index := range messages {
				messages[index] = Message{ID: "message-" + strconv.Itoa(index), Role: "assistant", Text: strings.Repeat("streamed response ", 64), Status: "done"}
			}
			source := snapshotSources{selected: ConversationState{Messages: messages}}
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				state := (SnapshotBuilder{}).build(source, time.Now())
				if _, err := json.Marshal(state); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
