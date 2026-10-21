// Package shellfixture keeps interactive-test startup files and shell history
// in disposable storage, even when tests run under a real desktop account.
package shellfixture

import (
	"os"
	"path/filepath"
)

func Create(root string) (string, error) {
	if err := os.MkdirAll(filepath.Join(root, "terminal-home"), 0700); err != nil {
		return "", err
	}
	path := filepath.Join(root, "terminal-shell")
	const script = "#!/bin/sh\nHOME=\"${0%/*}/terminal-home\"\nHISTFILE=/dev/null\nexport HOME HISTFILE\nexec /bin/sh \"$@\"\n"
	return path, os.WriteFile(path, []byte(script), 0700)
}
