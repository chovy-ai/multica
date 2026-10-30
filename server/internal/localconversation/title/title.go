// Package title names local conversations: a readable summary of the first
// message right away, and a model-generated title once the conversation is
// idle.
package title

import (
	"regexp"
	"strings"
	"unicode"
)

const (
	contextStart = "\n\n<!-- multica-context-snapshot:start -->\n"
	contextEnd   = "\n<!-- multica-context-snapshot:end -->"
	maxRunes     = 48
)

var defaults = map[string]bool{"新会话": true, "新建会话": true, "New conversation": true, "New Conversation": true}

// IsDefault reports a title nobody has chosen yet.
func IsDefault(title string) bool { return defaults[title] }

var (
	imageLink    = regexp.MustCompile(`!\[(?:\\.|[^\]\\])*\]\([^)]*\)`)
	link         = regexp.MustCompile(`\[((?:\\.|[^\]\\])*)\]\([^)]*\)`)
	tag          = regexp.MustCompile(`<[^>]*>`)
	escape       = regexp.MustCompile(`\\([\\` + "`" + `*_{}\[\]()#+.!>~-])`)
	bareURL      = regexp.MustCompile(`(?:mention|https?)://\S+`)
	emphasis     = regexp.MustCompile("[`*~]")
	linePrefix   = regexp.MustCompile(`(?m)^[\s#>-]+`)
	spaces       = regexp.MustCompile(`\s+`)
	mention      = regexp.MustCompile(`\[(@?(?:\\.|[^\]\\])*)\]\(mention://[^)\s]+\)`)
	paragraphs   = regexp.MustCompile(`\n\s*\n`)
	politeZH     = regexp.MustCompile(`^(?:请帮我|帮我|麻烦你|请问|能否)[，,\s]*`)
	politeEN     = regexp.MustCompile(`(?i)^(?:please|could you|can you|help me)\s+`)
	effortTags   = regexp.MustCompile(`(?is)<reasoning_effort>.*?</reasoning_effort>`)
	headingStart = regexp.MustCompile(`^#+\s*`)
	quoteStart   = regexp.MustCompile("^[\"'“「`]+")
	quoteEnd     = regexp.MustCompile("[\"'”」`]+$")
	unusable     = regexp.MustCompile(`(?i)[\r\n]|mention://|https?://|\]\(|</?reasoning_effort\b`)
)

// authored drops the context snapshot Desktop appends to a message.
func authored(content string) string {
	if i := strings.LastIndex(content, contextStart); i >= 0 && strings.HasSuffix(content, contextEnd) {
		return content[:i]
	}
	return content
}

func plainText(v string) string {
	v = imageLink.ReplaceAllString(v, " ")
	v = link.ReplaceAllString(v, "$1")
	v = tag.ReplaceAllString(v, " ")
	v = escape.ReplaceAllString(v, "$1")
	v = bareURL.ReplaceAllString(v, " ")
	v = emphasis.ReplaceAllString(v, "")
	v = linePrefix.ReplaceAllString(v, "")
	v = spaces.ReplaceAllString(v, " ")
	return strings.TrimSpace(v)
}

// shorten keeps at most limit runes, ending in an ellipsis, and keeps a
// whole Latin word when a nearby boundary exists.
func shorten(v string, limit int) string {
	r := []rune(v)
	if len(r) <= limit {
		return v
	}
	excerpt := string(r[:limit-1])
	if latin(r[limit-2]) && latin(r[limit-1]) {
		if b := strings.LastIndex(excerpt, " "); b >= len(excerpt)/2 {
			excerpt = excerpt[:b]
		}
	}
	return strings.TrimRightFunc(excerpt, unicode.IsSpace) + "…"
}

func latin(r rune) bool { return r < 128 && unicode.IsLetter(r) }

// Summarize is the first-message title: the request and readable labels of
// its @ references, never execution context.
func Summarize(content string) string {
	var labels []string
	text := mention.ReplaceAllStringFunc(authored(content), func(m string) string {
		label := plainText(strings.TrimPrefix(mention.FindStringSubmatch(m)[1], "@"))
		if label != "" && !contains(labels, label) {
			labels = append(labels, label)
		}
		return " "
	})
	var first string
	for _, p := range paragraphs.Split(text, -1) {
		if first = plainText(p); first != "" {
			break
		}
	}
	request := politeEN.ReplaceAllString(politeZH.ReplaceAllString(first, ""), "")
	if i := strings.IndexAny(request, "。！？!?"); i >= 0 {
		_, size := firstRune(request[i:])
		request = request[:i+size]
	}
	request = strings.TrimSpace(request)
	for i, l := range labels {
		labels[i] = shorten(l, 24)
	}
	refs := strings.Join(labels, "、")
	switch {
	case request != "" && refs != "":
		return shorten(shorten(request, 28)+" · "+refs, maxRunes)
	case request != "":
		return shorten(request, maxRunes)
	case refs != "":
		return shorten(refs, maxRunes)
	}
	return "新会话"
}

// Source is the readable authored text sent to the title model: no
// reference URLs or injected context.
func Source(content string) string {
	text := plainText(mention.ReplaceAllString(authored(content), "$1"))
	if r := []rune(text); len(r) > 8000 {
		return string(r[:8000])
	}
	return text
}

// Normalize accepts a model's title: one short line without links, quotes
// or headings.
func Normalize(output string) (string, bool) {
	t := strings.TrimSpace(effortTags.ReplaceAllString(output, ""))
	t = headingStart.ReplaceAllString(t, "")
	t = strings.TrimSpace(quoteEnd.ReplaceAllString(quoteStart.ReplaceAllString(t, ""), ""))
	if t == "" || len([]rune(t)) > 160 || unusable.MatchString(t) || IsDefault(t) {
		return "", false
	}
	return shorten(t, maxRunes), true
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func firstRune(s string) (rune, int) {
	for _, r := range s {
		return r, len(string(r))
	}
	return 0, 0
}
