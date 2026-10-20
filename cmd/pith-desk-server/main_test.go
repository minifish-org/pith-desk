package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTokenFileIsPrivateStableAndNeverOverwritesExistingData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "server-token")
	first, err := loadToken(path)
	if err != nil || len(first) != 64 {
		t.Fatalf("create token: %q %v", first, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("private token mode: %v %v", info, err)
	}
	second, err := loadToken(path)
	if err != nil || first != second {
		t.Fatal("restart changed the login token")
	}
	if err := os.WriteFile(path, []byte("existing-invalid-user-file\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadToken(path); err == nil {
		t.Fatal("accepted a weak token")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "existing-invalid-user-file\n" {
		t.Fatal("invalid existing file was overwritten")
	}
}

func TestTokenFileRejectsPublicPermissionsAndSymlinks(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "secret")
	if err := os.WriteFile(path, []byte("0123456789abcdef0123456789abcdef\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadToken(path); err == nil {
		t.Fatal("accepted a publicly readable token file")
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(path, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := loadToken(alias); err == nil {
		t.Fatal("accepted a token-file symlink")
	}
}
