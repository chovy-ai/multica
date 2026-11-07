package tailnetid

import (
	"regexp"
	"testing"
)

func TestHostnameIsAStableDNSLabel(t *testing.T) {
	a := Hostname("12D3KooWCwEfJGfVj1kpsnUD9ekFVSpu7utQSss3iGYW4Wbnhsgo")
	if a != Hostname("12D3KooWCwEfJGfVj1kpsnUD9ekFVSpu7utQSss3iGYW4Wbnhsgo") {
		t.Fatal("hostname is not stable")
	}
	if !regexp.MustCompile(`^m[0-9a-f]{20}$`).MatchString(a) {
		t.Fatalf("hostname %q is not a lowercase DNS label", a)
	}
	if a == Hostname("12D3KooWNsgibqPYxiYesCK3vmW4KmV4kUBjLmZtWqN6GZLLtzvy") {
		t.Fatal("different peers share a hostname")
	}
}
