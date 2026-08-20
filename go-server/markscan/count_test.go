package markscan

import "testing"

/*
The count comes out of the ENVELOPE, not the rows.

	{ "page": 1, "pageSize": 1000, "totalRecords": 258, "totalPages": 1 }

That field is what makes a live card affordable: one request with pageSize=1
carries the whole count, against the hundreds of pages FetchAllPages would pull
for the same number. Reading the array's length instead would report 1.
*/
func TestExtractTotalRecordsPrefersTheEnvelope(t *testing.T) {
	got := extractTotalRecords(map[string]any{
		"page": float64(1), "pageSize": float64(1),
		"totalRecords": float64(258), "totalPages": float64(1),
		"data": []any{map[string]any{"id": 1}},
	})
	if got != 258 {
		t.Errorf("got %d, want 258 — the single returned row was counted instead of the total", got)
	}
}

/*
An endpoint that answers with a bare array has no envelope to carry a total.

One row counted is closer to the truth than zero, and a zero here would read as
"this platform found nothing" — a finding, rather than the absence of one.
*/
func TestExtractTotalRecordsFallsBackToTheRows(t *testing.T) {
	if got := extractTotalRecords([]any{map[string]any{}, map[string]any{}}); got != 2 {
		t.Errorf("bare array gave %d, want 2", got)
	}
	// An envelope with rows but no total falls back the same way.
	if got := extractTotalRecords(map[string]any{
		"data": []any{map[string]any{}, map[string]any{}, map[string]any{}},
	}); got != 3 {
		t.Errorf("envelope with no total gave %d, want 3", got)
	}
	if got := extractTotalRecords(nil); got != 0 {
		t.Errorf("nothing gave %d, want 0", got)
	}
}

// The field is spelled differently by different endpoints; all of them mean the
// same thing and none of them should fall through to counting rows.
func TestExtractTotalRecordsAcceptsTheSpellings(t *testing.T) {
	for _, k := range []string{"totalRecords", "TotalRecords", "totalRecord", "total", "Total"} {
		if got := extractTotalRecords(map[string]any{k: float64(42)}); got != 42 {
			t.Errorf("%s gave %d, want 42", k, got)
		}
	}
}
