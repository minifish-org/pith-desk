package desk

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/minifish-org/pith-desk/internal/workspacefs"
	codingagent "github.com/minifish-org/pith/packages/coding-agent"
)

// os.Root guards every file operation, including symlink resolution at access
// time. This protects the file tools; an approved shell still has OS access.
type filePolicy struct {
	root        *os.Root
	path        string
	dataDir     string
	allowImages bool
}

func newFilePolicy(path, dataDir string) (*filePolicy, error) {
	path, err := workspacefs.Directory(path)
	if err != nil {
		return nil, err
	}
	dataDir, err = workspacefs.Directory(dataDir)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	return &filePolicy{root: root, path: path, dataDir: dataDir}, nil
}

func (p *filePolicy) checked(path string) (string, error) {
	return workspacefs.Relative(p.path, p.dataDir, codingagent.ResolveToCwd(path, p.path))
}

func (p *filePolicy) ReadFile(path string) ([]byte, error) {
	rel, err := p.checked(path)
	if err != nil {
		return nil, err
	}
	info, err := p.root.Stat(rel)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("Read a regular file inside the workspace")
	}
	return p.root.ReadFile(rel)
}

func (p *filePolicy) Access(path string) error {
	_, err := p.stat(path)
	return err
}

func (p *filePolicy) DetectImageMimeType(path string) (string, bool, error) {
	data, err := p.ReadFile(path)
	if err != nil {
		return "", false, err
	}
	if strings.HasPrefix(http.DetectContentType(data), "image/") {
		if !p.allowImages {
			return "", false, errors.New("Choose an image-capable model in Settings to read images")
		}
		mime := http.DetectContentType(data)
		if !supportedImageType(mime) {
			return "", false, errors.New("Use PNG, JPEG, GIF or WebP images")
		}
		return mime, true, nil
	}
	return "", false, nil
}

func (p *filePolicy) WriteFile(path string, content []byte) error {
	rel, err := p.checked(path)
	if err != nil {
		return err
	}
	if info, err := p.root.Stat(rel); err == nil && !info.Mode().IsRegular() {
		return errors.New("Write a regular file inside the workspace")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return p.root.WriteFile(rel, content, 0644)
}

func (p *filePolicy) Mkdir(path string) error {
	rel, err := p.checked(path)
	if err != nil {
		return err
	}
	return p.root.MkdirAll(rel, 0755)
}

func (p *filePolicy) CanonicalPath(path string) (string, error) {
	rel, err := p.checked(path)
	return filepath.Join(p.path, rel), err
}

func (p *filePolicy) stat(path string) (fs.FileInfo, error) {
	rel, err := p.checked(path)
	if err != nil {
		return nil, err
	}
	return p.root.Stat(rel)
}

type editOperations struct{ *filePolicy }

func (p editOperations) Stat(path string) (codingagent.EditFileInfo, error) {
	info, err := p.stat(path)
	if err != nil {
		return codingagent.EditFileInfo{}, err
	}
	return codingagent.EditFileInfo{IsFile: info.Mode().IsRegular()}, nil
}

type grepOperations struct{ *filePolicy }

func (p grepOperations) IsDirectory(path string) (bool, error) {
	info, err := p.stat(path)
	return err == nil && info.IsDir(), err
}

func (p grepOperations) ReadFile(path string) (string, error) {
	data, err := p.filePolicy.ReadFile(path)
	return string(data), err
}

type listOperations struct{ *filePolicy }

func (p listOperations) Exists(path string) (bool, error) {
	_, err := p.stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func (p listOperations) Stat(path string) (codingagent.LsStat, error) {
	info, err := p.stat(path)
	return codingagent.LsStat{Directory: err == nil && info.IsDir()}, err
}

func (p listOperations) ReadDir(path string) ([]string, error) {
	rel, err := p.checked(path)
	if err != nil {
		return nil, err
	}
	entries, err := fs.ReadDir(p.root.FS(), filepath.ToSlash(rel))
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, entry := range entries {
		if _, err := p.checked(filepath.Join(path, entry.Name())); err == nil {
			names = append(names, entry.Name())
		}
	}
	return names, nil
}

type findOperations struct{ *filePolicy }

func (p findOperations) Exists(path string) (bool, error) {
	return listOperations{p.filePolicy}.Exists(path)
}

func (p findOperations) Glob(pattern, cwd string, options codingagent.FindGlobOptions) ([]string, error) {
	base, err := p.checked(cwd)
	if err != nil {
		return nil, err
	}
	matcher, err := globPattern(pattern)
	if err != nil {
		return nil, err
	}
	results := []string{}
	err = fs.WalkDir(p.root.FS(), filepath.ToSlash(base), func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if options.Limit > 0 && len(results) >= options.Limit {
			return fs.SkipAll
		}
		if entry.IsDir() && entry.Name() == ".git" {
			return fs.SkipDir
		}
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		absolute := filepath.Join(p.path, filepath.FromSlash(path))
		if _, err := p.checked(absolute); err != nil {
			return nil
		}
		rel, err := filepath.Rel(cwd, absolute)
		if err != nil {
			return err
		}
		target := filepath.ToSlash(rel)
		if !strings.Contains(pattern, "/") {
			target = filepath.Base(rel)
		}
		if matcher.MatchString(target) {
			results = append(results, absolute)
		}
		return nil
	})
	return results, err
}

func globPattern(pattern string) (*regexp.Regexp, error) {
	// Validate character classes with the standard library before translating.
	if _, err := filepath.Match(strings.ReplaceAll(pattern, "**", "*"), ""); err != nil {
		return nil, fmt.Errorf("Invalid file pattern: %w", err)
	}
	var out strings.Builder
	out.WriteByte('^')
	runes := []rune(pattern)
	for i := 0; i < len(runes); i++ {
		switch runes[i] {
		case '*':
			if i+1 < len(runes) && runes[i+1] == '*' {
				i++
				if i+1 < len(runes) && runes[i+1] == '/' {
					i++
					out.WriteString("(?:.*/)?")
				} else {
					out.WriteString(".*")
				}
			} else {
				out.WriteString("[^/]*")
			}
		case '?':
			out.WriteString("[^/]")
		case '[':
			j := i + 1
			for j < len(runes) && runes[j] != ']' {
				j++
			}
			out.WriteString(string(runes[i : j+1]))
			i = j
		case '\\':
			// filepath.Match already rejected an incomplete escape above.
			i++
			out.WriteString(regexp.QuoteMeta(string(runes[i])))
		default:
			out.WriteString(regexp.QuoteMeta(string(runes[i])))
		}
	}
	out.WriteByte('$')
	return regexp.Compile(out.String())
}

func (s *Service) buildTools(policy *filePolicy) (*codingagent.ToolRegistry, error) {
	return s.active.buildTools(policy)
}
