// Pith Desk Server needs no GUI, MyGo initialization or external frontend files.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/minifish-org/pith-desk/internal/appdata"
	"github.com/minifish-org/pith-desk/internal/desk"
	"github.com/minifish-org/pith-desk/internal/host"
)

func main() {
	if err := run(); err != nil {
		log.Printf("Pith Desk Server: %v", err)
		os.Exit(1)
	}
}

func run() error {
	listen := flag.String("listen", "127.0.0.1:7540", "HTTP listen address")
	origin := flag.String("origin", "", "exact browser origin, required for an HTTPS reverse proxy")
	dataDir := flag.String("data-dir", "", "settings and conversation data directory")
	tokenFile := flag.String("token-file", "", "private server token file (default: DATA_DIR/server-token)")
	devURL := flag.String("dev-url", "", "loopback Vite origin for isolated frontend development")
	devUIRoot := flag.String("dev-ui-root", "", "local Pith UI checkout, only with --dev-url")
	flag.Parse()
	if flag.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %v", flag.Args())
	}
	if *devUIRoot != "" && *devURL == "" {
		return fmt.Errorf("--dev-ui-root requires --dev-url")
	}
	if *dataDir == "" && *devURL == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return err
		}
		*dataDir = filepath.Join(base, "Pith Desk Server")
	}
	directory, err := appdata.Dir(*dataDir, *devURL != "")
	if err != nil {
		return err
	}
	service, err := desk.New(directory)
	if err != nil {
		return err
	}
	defer service.Close()
	if *tokenFile == "" {
		*tokenFile = filepath.Join(directory, "server-token")
	}
	token := os.Getenv("PITH_DESK_TOKEN")
	if token == "" {
		token, err = loadToken(*tokenFile)
		if err != nil {
			return err
		}
		fmt.Printf("Server token file: %s\n", *tokenFile)
	}
	server, err := host.StartServer(service, host.ServerOptions{Listen: *listen, Origin: *origin, Token: token, FrontendURL: *devURL, FrontendUIRoot: *devUIRoot})
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	fmt.Printf("Pith Desk Server: %s\nData directory: %s\nPress Ctrl+C to stop the service. Browser disconnects do not stop tasks.\n", server.URL, directory)
	<-ctx.Done()
	return server.Close()
}

// An existing token file is never overwritten or silently replaced. The data
// directory's normal Desk lock also prevents concurrent first-run creation.
func loadToken(path string) (string, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return createToken(path)
	}
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 4096 {
		return "", fmt.Errorf("token file must be a private regular file (chmod 600): %s", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	token := string(data)
	// Accept a conventional single trailing newline in a mounted secret file.
	token = strings.TrimSuffix(strings.TrimSuffix(token, "\n"), "\r")
	if len(token) < 32 || strings.TrimSpace(token) != token {
		return "", fmt.Errorf("token file must contain a token of at least 32 characters")
	}
	return token, nil
}

func createToken(path string) (string, error) {
	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		return "", err
	}
	token := hex.EncodeToString(key[:])
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", err
	}
	_, writeErr := file.WriteString(token + "\n")
	return token, errors.Join(writeErr, file.Close())
}
