package handlers

import "testing"

func TestSearchAttemptsDerivesThePlatformFromTheURL(t *testing.T) {
	got := searchAttempts("", false, "https://www.facebook.com/groups/1406550424604001")
	want := []searchAttempt{{"facebook", false}, {"", false}}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestSearchAttemptsTriesBothSidesOfAnOpenWebPair(t *testing.T) {
	got := searchAttempts("", false, "https://some-pirate-site.ru/live/match")
	if len(got) != 3 || got[0] != (searchAttempt{"internet", false}) || got[1] != (searchAttempt{"internet", true}) {
		t.Fatalf("open web should be tried as host and as linking URL, got %v", got)
	}
}

func TestSearchAttemptsTakesAnExplicitPlatformAsGiven(t *testing.T) {
	got := searchAttempts("internet", true, "https://www.facebook.com/groups/1")
	if len(got) != 1 || got[0] != (searchAttempt{"internet", true}) {
		t.Fatalf("an explicit platform must not be second-guessed, got %v", got)
	}
}

func TestSearchRecordTreatsAnEmptyResponseAsNoRecord(t *testing.T) {
	for _, data := range []any{
		nil,
		map[string]any{},
		[]any{},
		[]any{map[string]any{}},
		"Not Found",
		// A status message is upstream's way of saying "no such URL".
		map[string]any{"message": "No data found", "success": false},
	} {
		if rec := searchRecord(data); rec != nil {
			t.Errorf("searchRecord(%#v) = %#v, want nil", data, rec)
		}
	}
}

func TestSearchRecordUnwrapsTheRecord(t *testing.T) {
	obj := map[string]any{"platform": "facebook"}
	if rec := searchRecord(obj); rec == nil {
		t.Error("an object with a value is a record")
	}
	// A single-row list is still one record to the screen showing it.
	if rec := searchRecord([]any{obj}); rec == nil {
		t.Error("a one-row list holds a record")
	} else if m, ok := rec.(map[string]any); !ok || m["platform"] != "facebook" {
		t.Errorf("got %#v, want the row itself", rec)
	}
}
