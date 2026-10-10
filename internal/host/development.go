package host

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/minifish-org/pith-desk/internal/desk"
)

// StartDevelopment keeps the UI, API and HMR socket on the authenticated host's
// origin. Production Start always uses embedded assets and never enables this.
func StartDevelopment(service *desk.Service, picker func() (string, error), frontendURL string, appearanceChanged ...func(desk.AppearanceMode)) (*Server, error) {
	u, err := url.Parse(frontendURL)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, fmt.Errorf("development frontend must be an http://127.0.0.1:PORT origin")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, fmt.Errorf("development frontend requires a loopback port")
	}
	u.Path = ""
	dev := &developmentFrontend{url: u, client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
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
	return start(service, picker, dev, appearanceChanged...)
}

type developmentFrontend struct {
	url    *url.URL
	client *http.Client
	proxy  *httputil.ReverseProxy
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

func developmentAssetPath(path string) bool {
	return path == "/__desk_hmr" || path == "/@vite/client" || path == "/@vite/env" ||
		path == "/node_modules/vite/dist/client/env.mjs" ||
		strings.HasPrefix(path, "/src/") || strings.HasPrefix(path, "/@id/") ||
		strings.HasPrefix(path, "/node_modules/.vite/")
}
