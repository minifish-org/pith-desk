package host

import (
	"fmt"
	"net"
	"net/url"
	"strings"

	"github.com/minifish-org/pith-desk/internal/desk"
)

// ServerOptions are intentionally independent of MyGo and the desktop token.
// Origin is the exact browser origin. A reverse proxy must preserve its Host.
type ServerOptions struct {
	Listen         string
	Origin         string
	Token          string
	FrontendURL    string // loopback Vite, development only
	FrontendUIRoot string // local UI source, only with FrontendURL
	PreviewListen  string // optional separate preview listener, defaults to loopback
	PreviewOrigin  string // exact external origin of that listener
}

func StartServer(service *desk.Service, options ServerOptions) (*Server, error) {
	if len(options.Token) < 32 || strings.TrimSpace(options.Token) != options.Token {
		return nil, fmt.Errorf("server token must contain at least 32 characters without surrounding whitespace")
	}
	var development *developmentFrontend
	var err error
	if options.FrontendUIRoot != "" && options.FrontendURL == "" {
		return nil, fmt.Errorf("local UI source requires a development frontend")
	}
	if options.FrontendURL != "" {
		development, err = newDevelopmentFrontend(DevelopmentOptions{URL: options.FrontendURL, UIRoot: options.FrontendUIRoot})
		if err != nil {
			return nil, err
		}
	}
	address := options.Listen
	if address == "" {
		address = "127.0.0.1:7540"
	}
	ln, err := net.Listen("tcp", address)
	if err != nil {
		return nil, err
	}
	origin := options.Origin
	if origin == "" {
		origin = "http://" + ln.Addr().String()
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" ||
		(u.Scheme != "https" && (u.Scheme != "http" || !loopbackHost(u.Hostname()))) {
		ln.Close()
		return nil, fmt.Errorf("server origin must be an exact HTTPS origin (or HTTP on localhost); set --origin for a reverse proxy")
	}
	if development != nil && (!loopbackHost(u.Hostname()) || !ln.Addr().(*net.TCPAddr).IP.IsLoopback()) {
		ln.Close()
		return nil, fmt.Errorf("frontend hot reload is available only on a loopback server")
	}
	s, err := startListener(service, nil, development, ln, origin, newServerAccess(options.Token, u.Scheme == "https"), nil)
	if err != nil {
		return nil, err
	}
	if err := s.startWebPreview(options.PreviewListen, options.PreviewOrigin); err != nil {
		_ = s.Close()
		return nil, err
	}
	return s, nil
}

func loopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
