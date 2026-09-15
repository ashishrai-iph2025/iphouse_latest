package markscan

import "testing"

/*
A blank field is a data gap, not a value. addSeg used to relabel it "Unknown"
and draw a bar for it — a breakdown panel like Country or Quality of Print
then showed "Unknown" sitting beside real values, indistinguishable from an
answer nobody would have picked. The row still belongs in every total and
KPI; it just names nothing for THIS breakdown, so it should contribute no bar
at all rather than a mislabeled one.
*/
func TestAddSegDropsBlankLabelsRatherThanBucketingThemAsUnknown(t *testing.T) {
	a := newSegAgg()
	addSeg(a, "Hindi", false)
	addSeg(a, "", false)
	addSeg(a, "   ", true)
	addSeg(a, "English", true)

	got := a.sorted()
	for _, s := range got {
		if s.Label == "Unknown" {
			t.Errorf("got an Unknown segment %+v; blank labels must be dropped, not bucketed", s)
		}
	}
	if len(got) != 2 {
		t.Fatalf("got %d segments, want 2 (Hindi, English) — blank rows must not add a segment", len(got))
	}
}

// A blank label must still be silently ignored (no panic, no phantom
// segment) even when it is the ONLY label ever passed in.
func TestAddSegAllBlankYieldsNoSegments(t *testing.T) {
	a := newSegAgg()
	addSeg(a, "", false)
	addSeg(a, "  ", true)
	if got := a.sorted(); len(got) != 0 {
		t.Errorf("got %d segments, want 0", len(got))
	}
}
