package desk

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/minifish-org/pith-desk/internal/localstore"
)

// The existing OAuth payload and normal filename stay unchanged. A backup's
// suffix binds it to the old configuration, so restart restores it only if
// that configuration is still committed. A new endpoint/client/scope never
// reads a pending backup as credentials.
type pendingMCPAuth struct{ path, backup string }

func mcpConfigFingerprint(config savedMCP) string {
	data, _ := json.Marshal(config)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (c *Connections) stageMCPAuth(config savedMCP, files localstore.Store) (*pendingMCPAuth, error) {
	path := c.mcpOAuthStore(config, files).path
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("MCP OAuth credentials are not a regular file")
	}
	pending := &pendingMCPAuth{path: path, backup: path + ".pending-" + mcpConfigFingerprint(config)}
	if err := os.Rename(path, pending.backup); err != nil {
		return nil, err
	}
	return pending, nil
}

func (p *pendingMCPAuth) finish(committed bool) error {
	if p == nil {
		return nil
	}
	if !committed {
		return os.Rename(p.backup, p.path)
	}
	err := os.Remove(p.backup)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// Resolve backups against the current committed config before another change
// can reuse its fingerprint. A failed cleanup/rollback must not become a login
// source for a re-added connection, a reverted config or a later sign-out.
// The caller holds the application mutex and the existing operation guards.
func (c *Connections) prepareMCPAuthChange(files localstore.Store) error {
	if err := c.recoverMCPAuth(files); err != nil {
		return fmt.Errorf("Resolve pending MCP OAuth changes before continuing: %w", err)
	}
	return nil
}

func (c *Connections) recoverMCPAuth(files localstore.Store) error {
	dir := filepath.Join(c.dataDir, "mcp-auth")
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	committed := map[string]bool{}
	for _, config := range c.mcpConfigs {
		name := filepath.Base(c.mcpOAuthStore(config, files).path)
		committed[name+".pending-"+mcpConfigFingerprint(config)] = true
	}
	for _, entry := range entries {
		name := entry.Name()
		parts := strings.Split(name, ".json.pending-")
		if len(parts) != 2 || len(parts[0]) != 64 || len(parts[1]) != 64 {
			continue
		}
		if _, err := hex.DecodeString(parts[0]); err != nil {
			continue
		}
		if _, err := hex.DecodeString(parts[1]); err != nil {
			continue
		}
		backup := filepath.Join(dir, name)
		if entry.IsDir() {
			return fmt.Errorf("MCP OAuth pending backup is a directory: %s", name)
		}
		path := filepath.Join(dir, parts[0]+".json")
		if committed[name] {
			// A later, valid login wins over an obsolete backup.
			if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
				if err := os.Rename(backup, path); err != nil {
					return err
				}
				continue
			} else if err != nil {
				return err
			}
		}
		if err := os.Remove(backup); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
