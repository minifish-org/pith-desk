package desk

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	authtypes "github.com/minifish-org/pith/packages/ai/auth/types"
)

func TestServerOAuthUsesHeadlessSDKMethodsAndForwardsManualPrompts(t *testing.T) {
	for provider, method := range map[string]string{"anthropic": "copy_code", "openai-codex": "device_code", "radius": "device-code"} {
		t.Run(provider, func(t *testing.T) {
			prompts := 0
			interaction := authtypes.NewInteraction(context.Background(), func(_ context.Context, prompt authtypes.AuthPrompt) (string, error) {
				prompts++
				if prompt.Type != authtypes.AuthPromptManualCode {
					t.Fatalf("unusable browser method shown: %+v", prompt)
				}
				return "remote-code", nil
			}, nil)
			auth := &authtypes.OAuthAuth{Login: func(ctx context.Context, remote authtypes.ProviderAuthInteraction) (*authtypes.OAuthCredential, error) {
				selected, err := remote.Prompt(ctx, authtypes.AuthPrompt{Type: authtypes.AuthPromptSelect, Options: []authtypes.AuthPromptOption{{ID: "browser"}, {ID: method}}})
				if err != nil || selected != method {
					t.Fatalf("method: %q %v", selected, err)
				}
				answer, err := remote.Prompt(ctx, authtypes.AuthPrompt{Type: authtypes.AuthPromptManualCode})
				if err != nil || answer != "remote-code" {
					t.Fatalf("manual code: %q %v", answer, err)
				}
				return nil, nil
			}}
			if provider == "anthropic" {
				auth.LoginWithOptions = func(ctx context.Context, remote authtypes.ProviderAuthInteraction, _ *authtypes.LoginOptions) (*authtypes.OAuthCredential, error) {
					return auth.Login(ctx, remote)
				}
			}
			if _, err := serverOAuthLogin(provider, auth, "")(context.Background(), interaction); err != nil || prompts != 1 {
				t.Fatalf("prompts: %d %v", prompts, err)
			}
		})
	}
	if ServerOAuthSupported("future-unreviewed-provider") {
		t.Fatal("unknown remote flow advertised")
	}
}

func TestServerOAuthAuditCoversEveryAdvertisedSDKFlow(t *testing.T) {
	s, _, _, _ := productFeatureService(t)
	catalog, err := s.Models("")
	if err != nil {
		t.Fatal(err)
	}
	for _, provider := range catalog.Providers {
		if provider.OAuth && !ServerOAuthSupported(provider.ID) {
			t.Errorf("audit new SDK OAuth flow before exposing it: %s", provider.ID)
		}
	}
}

func TestServerChatGPTDeviceBindingIsPrivateStableAndPassedToSDK(t *testing.T) {
	s, _, _, dir := productFeatureService(t)
	id, err := s.oauthDeviceID()
	if err != nil || len(id) != 36 {
		t.Fatalf("device ID: %q %v", id, err)
	}
	s.Close()
	if _, err := s.oauthDeviceID(); err == nil {
		t.Fatal("closed profile still accepted an installation binding operation")
	}
	s, err = New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if again, err := s.oauthDeviceID(); err != nil || again != id {
		t.Fatalf("binding changed: %q %v", again, err)
	}
	info, err := os.Stat(filepath.Join(dir, "oauth-device.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("device file permissions: %v %v", info, err)
	}
	auth := &authtypes.OAuthAuth{LoginWithOptions: func(_ context.Context, _ authtypes.ProviderAuthInteraction, options *authtypes.LoginOptions) (*authtypes.OAuthCredential, error) {
		if options.GetDeviceID() != id {
			t.Fatal("SDK lost the installation binding")
		}
		return nil, nil
	}}
	if _, err := serverOAuthLogin("openai-chatgpt", auth, id)(context.Background(), authtypes.NewInteraction(nil, nil, nil)); err != nil {
		t.Fatal(err)
	}
}
