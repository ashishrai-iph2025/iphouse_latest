package handlers

import (
	"strings"
	"testing"
)

func TestGenClientAdminPasswordHasEveryCharacterClass(t *testing.T) {
	const (
		lower  = "abcdefghijkmnopqrstuvwxyz"
		upper  = "ABCDEFGHJKLMNPQRSTUVWXYZ"
		digits = "23456789"
		syms   = "!@#$%*?"
	)
	hasAny := func(s, set string) bool { return strings.ContainsAny(s, set) }

	// Run several times — the guaranteed classes are shuffled into random
	// positions, so a single pass could pass by luck even with a broken
	// generator.
	for i := 0; i < 20; i++ {
		p := genClientAdminPassword(12)
		if len(p) != 12 {
			t.Fatalf("password %q: want length 12, got %d", p, len(p))
		}
		if !hasAny(p, lower) || !hasAny(p, upper) || !hasAny(p, digits) || !hasAny(p, syms) {
			t.Errorf("password %q missing a required character class", p)
		}
		// No ambiguous characters (0/O/1/l/I) — the credential is emailed and
		// typed back in, and these are the pairs people mistype.
		if strings.ContainsAny(p, "0O1lI") {
			t.Errorf("password %q contains an excluded ambiguous character", p)
		}
	}
}

func TestGenClientAdminPasswordFloorsShortLengths(t *testing.T) {
	if got := len(genClientAdminPassword(1)); got != 4 {
		t.Errorf("genClientAdminPassword(1): want floor of 4, got %d", got)
	}
}
