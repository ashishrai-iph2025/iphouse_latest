package email

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestEmailHasInlineLogo(t *testing.T) {
	if len(logoPNG) == 0 {
		t.Fatal("logo.png did not embed")
	}
	// PNG magic bytes
	if len(logoPNG) < 8 || string(logoPNG[1:4]) != "PNG" {
		t.Fatalf("embedded logo is not a PNG (first bytes: %v)", logoPNG[:8])
	}

	msg := buildMessage("IP House <no-reply@markscan.in>", "a@b.com", "Verify Your Email", logoBanner+"<p>Hello</p>")

	checks := []string{
		"Content-Type: multipart/related; boundary=",
		"Content-Type: text/html; charset=UTF-8",
		`src="cid:iphouse-logo"`,
		"Content-Type: image/png",
		"Content-ID: <iphouse-logo>",
		"Content-Disposition: inline;",
	}
	for _, c := range checks {
		if !strings.Contains(msg, c) {
			t.Errorf("message missing %q", c)
		}
	}

	// The base64 image body must decode back to the exact embedded bytes.
	parts := strings.SplitN(msg, "Content-ID: <iphouse-logo>", 2)
	if len(parts) != 2 {
		t.Fatal("no logo part")
	}
	after := parts[1]
	body := after[strings.Index(after, "\r\n\r\n")+4:]
	body = body[:strings.Index(body, "\r\n--")]
	decoded, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(body, "\r\n", ""))
	if err != nil {
		t.Fatalf("logo base64 does not decode: %v", err)
	}
	if len(decoded) != len(logoPNG) {
		t.Fatalf("decoded logo len=%d, embedded len=%d", len(decoded), len(logoPNG))
	}
	t.Logf("OK: multipart/related email, inline PNG %d bytes, base64 round-trips", len(logoPNG))
}
