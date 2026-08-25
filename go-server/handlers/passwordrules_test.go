package handlers

import "testing"

/*
The complexity rules, pinned against the policy rather than against literals.

These run without a database: Policy() falls back to DefaultSecurityPolicy when
the row cannot be read, which is exactly the shipped configuration — 8
characters, one number, no case or symbol requirement. So what is asserted here
is what a fresh install actually enforces, and a change to those defaults will
fail this file rather than pass silently.
*/
func TestValidatePasswordAgainstTheShippedDefaults(t *testing.T) {
	for _, tc := range []struct {
		name string
		pw   string
		ok   bool
	}{
		{"long enough with a digit", "correct1horse", true},
		{"exactly the minimum", "abcdefg1", true},
		{"one short", "abcdef1", false},
		{"no digit at all", "correcthorse", false},
		{"digits only, long enough", "12345678", true},
		{"empty", "", false},

		/* Length is counted in RUNES, not bytes. "áéíóúü1" is 13 bytes and 7
		   characters, so a byte-counted rule accepts a password two characters
		   short of the minimum — and refuses nothing, which is the direction
		   that goes unnoticed. */
		{"six accented characters and a digit", "áéíóúü1", false},
		{"seven accented characters and a digit", "áéíóúüñ1", true},
		{"eight accented characters, no digit", "áéíóúüñç", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidatePassword(tc.pw)
			if tc.ok && err != nil {
				t.Fatalf("ValidatePassword(%q) = %v, want accepted", tc.pw, err)
			}
			if !tc.ok && err == nil {
				t.Fatalf("ValidatePassword(%q) accepted it, want refused", tc.pw)
			}
		})
	}
}

/*
The refusal has to say everything that is wrong, in one message.

Told one rule at a time, somebody fixes the length, submits, is told about the
digit, submits again — and never learns how many rounds are left. This is the
behaviour that makes the difference, so it is asserted rather than left to the
comment on the function.
*/
func TestTheRefusalNamesEveryUnmetRule(t *testing.T) {
	err := ValidatePassword("abc")
	if err == nil {
		t.Fatal("want a refusal")
	}
	msg := err.Error()
	for _, want := range []string{"characters", "number"} {
		if !contains(msg, want) {
			t.Errorf("message %q does not mention %q", msg, want)
		}
	}
}

// A sentence per rule, for a form to show before anything is typed. The history
// line only appears when reuse checking is switched on.
func TestPasswordRequirementsReadAsSentences(t *testing.T) {
	got := PasswordRequirements()
	if len(got) == 0 {
		t.Fatal("want at least the length requirement")
	}
	if !contains(got[0], "8") {
		t.Errorf("first requirement = %q, want it to name the minimum length", got[0])
	}
	var mentionsHistory bool
	for _, line := range got {
		if contains(line, "last 3 passwords") {
			mentionsHistory = true
		}
	}
	if !mentionsHistory {
		t.Errorf("got %v, want the default 3-password history to be stated", got)
	}
}

/*
joinWithAnd is what makes the refusal read like a sentence instead of a list of
field names. Worth pinning because the empty and single cases are the ones a
rewrite gets wrong, and both are reachable — a policy with one rule unmet is the
common case.
*/
func TestJoinWithAnd(t *testing.T) {
	for _, tc := range []struct {
		in   []string
		want string
	}{
		{nil, ""},
		{[]string{"a"}, "a"},
		{[]string{"a", "b"}, "a and b"},
		{[]string{"a", "b", "c"}, "a, b and c"},
	} {
		if got := joinWithAnd(tc.in); got != tc.want {
			t.Errorf("joinWithAnd(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func contains(haystack, needle string) bool {
	return len(needle) == 0 || len(haystack) >= len(needle) &&
		(haystack == needle || indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
