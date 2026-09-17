package handlers

/*
HOW MANY URLS ACTUALLY LANDED.

PushInfringements answers 200 with a sentence that carries the number it stored,
and that number is not always the number sent: seven Facebook URLs came back as
one. The portal discarded the whole body on success, so the bell announced seven
— the count it had posted — while the submission history showed what upstream
kept. Two screens disagreeing, both honest, neither complete.

The parsing is the load-bearing part, because everything downstream trusts it:
read it wrong and the bell starts reporting a confident, invented figure, which
is worse than the overcount it replaced.
*/

import "testing"

/*
The real response body, and the shapes around it.

The first case is verbatim from the live API — the exact sentence a successful
push returns. It is here rather than paraphrased because this whole feature
hangs on one regex matching one wording, and a wording that drifts should fail
here rather than quietly stop reporting.
*/
func TestAcceptedCountReadsTheSuccessBody(t *testing.T) {
	for _, c := range []struct {
		name  string
		in    any
		want  int
		known bool
	}{
		// Verbatim from the API, for one URL and for many.
		{"live body, one", "Successfully added 1 infringements.", 1, true},
		{"live body, several", "Successfully added 17 infringements.", 17, true},

		/* ZERO IS AN ANSWER, not a missing one. A push where nothing was stored
		   is exactly the case this exists to report, so it must not come back
		   looking like "the response did not say". */
		{"nothing stored", "Successfully added 0 infringements.", 0, true},

		// Wrapped in an object, which some endpoints here do.
		{"message key", map[string]any{"message": "Successfully added 4 infringements."}, 4, true},
		{"Result key", map[string]any{"Result": "Added 9 infringements"}, 9, true},

		/* NO COUNT IS A DIFFERENT STATE from zero — the caller falls back to
		   the sent figure rather than announcing that nothing landed. */
		{"no number", "Success", 0, false},
		{"empty", "", 0, false},
		{"nil", nil, 0, false},
		{"unrelated number", "Request 12345 accepted", 0, false},
	} {
		got, known := acceptedCount(c.in)
		if known != c.known {
			t.Errorf("%s: known = %v, want %v (in: %v)", c.name, known, c.known, c.in)
			continue
		}
		if known && got != c.want {
			t.Errorf("%s: acceptedCount = %d, want %d", c.name, got, c.want)
		}
	}
}

/*
A batch total is ALL or NOTHING.

If one platform in a submission did not report a count, adding the ones that did
to the sent count of the one that did not produces a number that is neither —
and it would be shown with exactly the confidence of a measured one. Refusing to
total it makes the caller fall back to "submitted", which is at least a figure
that means something.
*/
func TestAcceptedTotalRefusesToGuess(t *testing.T) {
	n2, n5 := 2, 5

	total, known := acceptedTotal([]uploadResult{
		{Platform: "Facebook", Count: 7, OK: true, Accepted: &n2},
		{Platform: "internet", Count: 9, OK: true, Accepted: &n5},
	})
	if !known || total != 7 {
		t.Errorf("total = %d (known %v), want 7 known", total, known)
	}

	// One platform silent — no total may be claimed.
	if _, known := acceptedTotal([]uploadResult{
		{Platform: "Facebook", Count: 7, OK: true, Accepted: &n2},
		{Platform: "internet", Count: 9, OK: true},
	}); known {
		t.Error("a total was claimed although one platform reported no count")
	}

	/* A FAILED group is skipped, not treated as silent. It stored nothing and
	   said so through its error; letting it suppress the total would hide the
	   figure for the platforms that did land. */
	total, known = acceptedTotal([]uploadResult{
		{Platform: "Facebook", Count: 7, OK: true, Accepted: &n2},
		{Platform: "internet", Count: 9, OK: false, Error: "API error 400"},
	})
	if !known || total != 2 {
		t.Errorf("with one failed group total = %d (known %v), want 2 known", total, known)
	}

	// Nothing succeeded — nothing to total.
	if _, known := acceptedTotal([]uploadResult{
		{Platform: "Facebook", Count: 7, OK: false, Error: "API error 400"},
	}); known {
		t.Error("a total was claimed when every group failed")
	}

	// Zero stored across the batch is a real, reportable total.
	zero := 0
	total, known = acceptedTotal([]uploadResult{
		{Platform: "Facebook", Count: 7, OK: true, Accepted: &zero},
	})
	if !known || total != 0 {
		t.Errorf("all-zero batch = %d (known %v), want 0 known — this is the case "+
			"the reader most needs told", total, known)
	}
}
