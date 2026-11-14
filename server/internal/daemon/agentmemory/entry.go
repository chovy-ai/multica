package agentmemory

import (
	"bytes"
	"strings"
	"time"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

type Kind string
type WriteMode string
type Warning string

type Entry struct {
	Path        string    `json:"path"`
	Kind        Kind      `json:"kind"`
	ProjectDir  string    `json:"project_dir"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	Source      string    `json:"source"`
	Body        string    `json:"body,omitempty"`
	extra       []*yaml.Node
}
type ProjectRef struct{ ID, Title string }
type WriteInput struct {
	Path, Title, Description, Body string
	Document                       *string
	Mode                           WriteMode
	Source                         string
	Project                        ProjectRef
	ExpectedUpdatedAt              *time.Time
}
type SearchHit struct {
	Path    string `json:"path"`
	Title   string `json:"title"`
	Snippet string `json:"snippet"`
}
type TrashItem struct {
	TrashPath    string    `json:"trash_path"`
	OriginalPath string    `json:"original_path"`
	Title        string    `json:"title"`
	DeletedAt    time.Time `json:"deleted_at"`
}
type Project struct {
	Dir   string `json:"dir"`
	Title string `json:"title"`
}

func validate(in WriteInput) error {
	if in.Mode != "create" && in.Mode != "update" {
		return ErrInvalidInput
	}
	if !utf8.ValidString(in.Body) || !utf8.ValidString(in.Title) || !utf8.ValidString(in.Description) {
		return ErrInvalidInput
	}
	if n := utf8.RuneCountInString(in.Title); n < 1 || n > 100 || strings.ContainsAny(in.Title, "\r\n") {
		return ErrInvalidInput
	}
	if n := utf8.RuneCountInString(in.Description); n < 1 || n > 200 || strings.ContainsAny(in.Description, "\r\n") {
		return ErrInvalidInput
	}
	if strings.TrimSpace(in.Body) == "" {
		return ErrInvalidInput
	}
	if len(in.Body) > 8192 {
		return ErrTooLarge
	}
	return nil
}

func ParseEntry(path string, data []byte) (Entry, error) {
	var e Entry
	normalized, err := NormalizePath(path)
	if err != nil {
		return e, err
	}
	if !bytes.HasPrefix(data, []byte("---\n")) {
		return e, ErrInvalidInput
	}
	end := bytes.Index(data[4:], []byte("\n---\n"))
	if end < 0 {
		return e, ErrInvalidInput
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(data[4:4+end], &doc); err != nil {
		return e, ErrInvalidInput
	}
	if len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return e, ErrInvalidInput
	}
	e.Path = normalized
	parts := strings.Split(normalized, "/")
	e.Kind = Kind(parts[0])
	if e.Kind == "project" {
		e.ProjectDir = parts[1]
	}
	seen := map[string]bool{}
	for i := 0; i < len(doc.Content[0].Content); i += 2 {
		k, v := doc.Content[0].Content[i], doc.Content[0].Content[i+1]
		if seen[k.Value] {
			return Entry{}, ErrInvalidInput
		}
		seen[k.Value] = true
		switch k.Value {
		case "title":
			e.Title = v.Value
		case "description":
			e.Description = v.Value
		case "created_at":
			e.CreatedAt, err = time.Parse(time.RFC3339, v.Value)
		case "updated_at":
			e.UpdatedAt, err = time.Parse(time.RFC3339, v.Value)
		case "source":
			e.Source = v.Value
		default:
			e.extra = append(e.extra, k, v)
		}
		if err != nil {
			return Entry{}, ErrInvalidInput
		}
	}
	e.Body = string(data[4+end+5:])
	if e.CreatedAt.IsZero() || e.UpdatedAt.IsZero() {
		return Entry{}, ErrInvalidInput
	}
	return e, nil
}

func FormatEntry(e Entry) ([]byte, error) {
	node := yaml.Node{Kind: yaml.MappingNode}
	for _, field := range [][2]string{{"title", e.Title}, {"description", e.Description}, {"created_at", e.CreatedAt.UTC().Format(time.RFC3339)}, {"updated_at", e.UpdatedAt.UTC().Format(time.RFC3339)}, {"source", e.Source}} {
		node.Content = append(node.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: field[0]}, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: field[1]})
	}
	node.Content = append(node.Content, e.extra...)
	data, err := yaml.Marshal(&node)
	if err != nil {
		return nil, err
	}
	return []byte("---\n" + string(data) + "---\n" + e.Body), nil
}
