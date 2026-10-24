package desk

import (
	"encoding/json"
	"testing"

	aitypes "github.com/minifish-org/pith/packages/ai/types"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

func TestVisibleMessagesPreserveRecordedTimestampsAfterReopen(t *testing.T) {
	s, _, conversation, _ := productFeatureService(t)
	manager, err := codingagent.OpenSession(s.sessionAdapter().file(conversation.ID))
	if err != nil {
		t.Fatal(err)
	}
	const userTime, replyTime = 1791899580000.0, 1791899640000.0
	appendFeatureMessage(t, manager, aitypes.NewUserMessageVariant(aitypes.NewUserMessage("Question", userTime)))
	assistant := aitypes.NewAssistantMessage(aitypes.ApiOpenAICompletions, "fixture", "offline", replyTime)
	assistant.StopReason = aitypes.StopReasonStop
	assistant.Content = []aitypes.ContentBlock{aitypes.TextBlock("Answer")}
	appendFeatureMessage(t, manager, aitypes.NewAssistantMessageVariant(assistant))
	if err := manager.Close(); err != nil {
		t.Fatal(err)
	}
	manager, err = codingagent.OpenSession(s.sessionAdapter().file(conversation.ID))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	raw, err := json.Marshal(messagesFrom(manager))
	if err != nil {
		t.Fatal(err)
	}
	var messages []map[string]any
	if err := json.Unmarshal(raw, &messages); err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[0]["timestamp"] != userTime || messages[1]["timestamp"] != replyTime {
		t.Fatalf("recorded user/reply times were lost: %s", raw)
	}
}
