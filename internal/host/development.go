package host

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/minifish-org/pith-desk/internal/desk"
)

// DevelopmentOptions configure the loopback-only frontend and optional source root.
type DevelopmentOptions struct {
	URL    string
	UIRoot string // explicit local frontend checkout; never inferred from an environment variable
}

// StartDevelopment keeps UI, API and HMR on the authenticated host's origin.
// Production Start always uses embedded assets and never enables this.
func StartDevelopment(service *desk.Service, picker func() (string, error), options DevelopmentOptions, appearanceChanged ...func(desk.AppearanceMode)) (*Server, error) {
	dev, err := newDevelopmentFrontend(options)
	if err != nil {
		return nil, err
	}
	return start(service, picker, dev, appearanceChanged...)
}

func newDevelopmentFrontend(options DevelopmentOptions) (*developmentFrontend, error) {
	u, err := url.Parse(options.URL)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, fmt.Errorf("development frontend must be an http://127.0.0.1:PORT origin")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, fmt.Errorf("development frontend requires a loopback port")
	}
	u.Path = ""
	var uiRoot string
	if options.UIRoot != "" {
		uiRoot, err = filepath.EvalSymlinks(options.UIRoot)
		if err != nil {
			return nil, fmt.Errorf("local UI root: %w", err)
		}
		uiRoot, err = filepath.Abs(uiRoot)
		if err != nil {
			return nil, err
		}
		info, statErr := os.Stat(uiRoot)
		if statErr != nil || !info.IsDir() {
			return nil, fmt.Errorf("local UI root must be a directory")
		}
	}
	dev := &developmentFrontend{url: u, uiRoot: uiRoot, client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	dev.proxy = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(u)
			// Vite checks WebSocket origins. The outer host has already checked
			// the browser's original origin before forwarding the HMR request.
			if r.Out.Header.Get("Origin") != "" {
				r.Out.Header.Set("Origin", u.String())
			}
		},
		ModifyResponse: func(r *http.Response) error {
			r.Header.Set("Cache-Control", "no-store")
			// Keep Desk's policy, including same-origin connections and framing.
			r.Header.Del("Content-Security-Policy")
			return nil
		},
	}
	return dev, nil
}

type developmentFrontend struct {
	url    *url.URL
	client *http.Client
	proxy  *httputil.ReverseProxy
	uiRoot string
}

func (d *developmentFrontend) index(ctx context.Context) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.url.String()+"/", nil)
	if err != nil {
		return nil, err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("development frontend returned %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, (2<<20)+1))
	if err == nil && len(data) > 2<<20 {
		err = fmt.Errorf("development index exceeds size limit")
	}
	return data, err
}

func (d *developmentFrontend) assetPath(path string) bool {
	if d.uiRoot != "" && strings.HasPrefix(path, "/@fs/") {
		file := filepath.FromSlash(strings.TrimPrefix(path, "/@fs"))
		resolved, err := filepath.EvalSymlinks(file)
		if err != nil {
			// Vite resolves source imports ending in .js to their .ts file.
			parent, parentErr := filepath.EvalSymlinks(filepath.Dir(file))
			if parentErr != nil {
				return false
			}
			resolved = filepath.Join(parent, filepath.Base(file))
		}
		relative, err := filepath.Rel(d.uiRoot, resolved)
		return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
	}
	return path == "/__desk_hmr" || path == "/@vite/client" || path == "/@vite/env" || path == "/@react-refresh" ||
		path == "/node_modules/vite/dist/client/env.mjs" ||
		strings.HasPrefix(path, "/src/") || strings.HasPrefix(path, "/@id/") ||
		strings.HasPrefix(path, "/node_modules/")
}
