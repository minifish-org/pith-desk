package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDevelopmentDataIsSeparateIncludingSymlinkParents(t *testing.T) {
	base := t.TempDir()
	base, err := filepath.EvalSymlinks(base)
	if err != nil {
		t.Fatal(err)
	}
	production := filepath.Join(base, "Pith Desk")
	if err := os.Mkdir(production, 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(production, alias); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{production, base, filepath.Join(production, "dev"), alias, filepath.Join(alias, "not-created")} {
		if _, err := resolveApplicationDataDir(path, base, true); err == nil {
			t.Errorf("accepted development path overlapping production: %q", path)
		}
	}
	dev, err := resolveApplicationDataDir("", base, true)
	if err != nil || dev != filepath.Join(base, "Pith Desk Development") {
		t.Fatalf("development default: %q %v", dev, err)
	}
	prod, err := resolveApplicationDataDir("", base, false)
	if err != nil || prod != production {
		t.Fatalf("production default: %q %v", prod, err)
	}
	if _, err := resolveApplicationDataDir(filepath.Join(t.TempDir(), "中文 data"), base, true); err != nil {
		t.Fatal(err)
	}
}

func TestDevelopmentDataRejectsCaseAliases(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS conservatively reserves application-data case variants")
	}
	base := t.TempDir()
	production := filepath.Join(base, "Pith Desk")
	// Nonexistent final names must already remain reserved for production.
	for _, path := range []string{filepath.Join(base, "pith desk"), filepath.Join(base, "PITH DESK", "not-created")} {
		if _, err := resolveApplicationDataDir(path, base, true); err == nil {
			t.Fatalf("accepted planned case alias %q", path)
		}
	}
	if err := os.Mkdir(production, 0700); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(base, "pith desk"), filepath.Join(base, "PITH DESK", "not-created")} {
		if _, err := resolveApplicationDataDir(path, base, true); err == nil {
			t.Fatalf("accepted existing case alias %q", path)
		}
	}
}
