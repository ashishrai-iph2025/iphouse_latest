package handlers

import (
	"strings"
	"testing"
)

// A reading with one of each family, so the rollup rules can be exercised
// without a warehouse. Removed is a pointer for the reason RealtimePlatform
// says it is: nil means "not counted", which is not zero.
func rt(key, family string, count int64, removed *int64, basis string) RealtimePlatform {
	return RealtimePlatform{
		Key: key, Label: strings.ToUpper(key[:1]) + key[1:], Family: family,
		Count: count, Removed: removed, RemovalBasis: basis,
	}
}

func i64(v int64) *int64 { return &v }

const (
	dead    = "URL no longer reachable"
	delist  = "an approved de-indexing notice"
	openWeb = "open-web"
)

/*
Open Web can never be folded.

It carries most of the volume on every sports report, so a control that could
tip it into an "other" row is one tick away from a card that understates by an
order of magnitude. The guard is the FAMILY, not the key — a rename upstream
must not quietly make it configurable — and this pins that a stored list naming
it is ignored rather than obeyed.
*/
func TestOpenWebIsNeverRolledUp(t *testing.T) {
	in := []RealtimePlatform{
		rt(openWeb, "open-web", 4312, i64(2810), delist),
		rt("facebook", "social", 121, i64(44), dead),
		rt("tiktok", "social", 4, i64(4), dead),
	}
	out := applyRealtimeRollup(in, parseRollup("open-web,facebook,tiktok"))

	if out[0].Key != openWeb || out[0].Count != 4312 {
		t.Fatalf("open web was folded away: %+v", out[0])
	}
	if len(out) != 2 {
		t.Fatalf("want open web plus one rollup, got %d rows", len(out))
	}
	if out[1].Key != realtimeRollupKey || out[1].Count != 125 {
		t.Errorf("the two social rows did not fold into one 125: %+v", out[1])
	}
}

/*
The fold SUMS. It does not hide.

The whole difference between this and switching a platform off is that the
count survives: a client who folds four quiet platforms still has their four
counts in the total on the card, in one row. A rollup that dropped them would
make the platform rows stop adding up to the headline, which is the one
arithmetic a reader does on this card without being asked to.
*/
func TestTheRollupSumsEveryMemberItAbsorbs(t *testing.T) {
	in := []RealtimePlatform{
		rt("facebook", "social", 121, i64(44), dead),
		rt("vk", "social", 7, i64(1), dead),
		rt("ugc-other", "ugc", 233, i64(0), dead),
	}
	out := applyRealtimeRollup(in, parseRollup("facebook,vk,ugc-other"))

	if len(out) != 1 {
		t.Fatalf("three folded platforms gave %d rows", len(out))
	}
	if out[0].Count != 361 {
		t.Errorf("count = %d, want 121+7+233 = 361", out[0].Count)
	}
	if out[0].Removed == nil || *out[0].Removed != 45 {
		t.Errorf("removed = %v, want 44+1+0 = 45", out[0].Removed)
	}
	// Every member counted removals the same way, so the word survives.
	if out[0].RemovalBasis != dead {
		t.Errorf("basis = %q, want it carried through where the members agree", out[0].RemovalBasis)
	}
}

/*
A member that did not answer makes the rollup's removal figure ABSENT, not
short.

Summing what did answer would produce a floor, and the card draws a floor as a
share bar and a percentage — a measured-looking claim about enforcement built on
a platform nobody could read. Absent, the card draws no removal for that row at
all, which is the honest thing it already does per platform.
*/
func TestTheRollupDeclinesToSumAShortReading(t *testing.T) {
	in := []RealtimePlatform{
		rt("facebook", "social", 121, i64(44), dead),
		rt("vk", "social", 7, nil, ""), // did not answer
	}
	out := applyRealtimeRollup(in, parseRollup("facebook,vk"))

	if len(out) != 1 {
		t.Fatalf("want one rollup row, got %d", len(out))
	}
	if out[0].Count != 128 {
		t.Errorf("count = %d — the identified half is still a sum of what was counted", out[0].Count)
	}
	if out[0].Removed != nil {
		t.Errorf("removed = %d, want nothing: one member could not be read", *out[0].Removed)
	}
}

/*
Two different measures under one word do not get one word.

"Removed" means an approved de-indexing on some platforms and an unreachable URL
on others — removedWord in RealtimeCard.tsx exists entirely to keep those apart.
The rollup is the one row that could stack both, so where its members disagree
it carries no basis and the card falls back to the neutral word.
*/
func TestAMixedRollupCarriesNoRemovalBasis(t *testing.T) {
	in := []RealtimePlatform{
		rt("ugc-other", "ugc", 233, i64(10), dead),
		rt("facebook", "social", 121, i64(44), delist),
	}
	out := applyRealtimeRollup(in, parseRollup("ugc-other,facebook"))
	if out[0].RemovalBasis != "" {
		t.Errorf("basis = %q — two measures were labelled as one", out[0].RemovalBasis)
	}
}

/*
Folding ONE platform is a rename, and this does not do renames.

"UGC & Social Media: 918" over a row that is entirely Telegram is strictly less
information under a vaguer name — the opposite of what a summary row is for. So
a selection that catches a single platform on this reading leaves it as itself,
and the card looks exactly as it did.
*/
func TestASingleMemberIsLeftAsItself(t *testing.T) {
	in := []RealtimePlatform{
		rt(openWeb, "open-web", 4312, i64(2810), delist),
		rt("facebook", "social", 121, i64(44), dead),
	}
	out := applyRealtimeRollup(in, parseRollup("facebook,vk,tiktok"))
	if len(out) != 2 || out[1].Key != "facebook" {
		t.Errorf("a lone member was folded into a rollup: %+v", out)
	}
}

/*
An empty selection changes nothing at all.

This is the state every install is in until somebody configures a card, so it is
the one behaviour that must be byte-for-byte what it was before any of this
existed.
*/
func TestAnEmptySelectionLeavesTheReadingAlone(t *testing.T) {
	in := []RealtimePlatform{
		rt(openWeb, "open-web", 4312, i64(2810), delist),
		rt("facebook", "social", 121, i64(44), dead),
	}
	for _, sel := range []string{"", "   ", ",,"} {
		out := applyRealtimeRollup(in, parseRollup(sel))
		if len(out) != len(in) || out[0].Key != in[0].Key || out[1].Key != in[1].Key {
			t.Errorf("selection %q reshaped an unconfigured reading: %+v", sel, out)
		}
	}
}

/*
The rollup takes the SLOT of the first member it absorbs.

The handler sorts by count straight afterwards, so this decides nothing about
the finished card — but it means the function is correct on its own terms, and a
list that keeps its shape is far easier to read in a test than one that always
ends with the rollup last.
*/
func TestTheRollupKeepsTheFirstMembersPlace(t *testing.T) {
	in := []RealtimePlatform{
		rt("facebook", "social", 121, i64(44), dead),
		rt(openWeb, "open-web", 4312, i64(2810), delist),
		rt("vk", "social", 7, i64(1), dead),
	}
	out := applyRealtimeRollup(in, parseRollup("facebook,vk"))
	if len(out) != 2 {
		t.Fatalf("want rollup + open web, got %d", len(out))
	}
	if out[0].Key != realtimeRollupKey {
		t.Errorf("row 0 = %q, want the rollup in Facebook's old slot", out[0].Key)
	}
	if out[1].Key != openWeb {
		t.Errorf("row 1 = %q, want open web where it was", out[1].Key)
	}
}

// The stored form round-trips: what the screen sends is what comes back.
func TestTheStoredSelectionRoundTrips(t *testing.T) {
	stored := joinRollup([]string{" Facebook ", "vk", "facebook", "", "TikTok"})
	if stored != "facebook,vk,tiktok" {
		t.Fatalf("stored as %q — want lowercased, trimmed, de-duplicated, in order", stored)
	}
	got := parseRollup(stored)
	for _, k := range []string{"facebook", "vk", "tiktok"} {
		if !got[k] {
			t.Errorf("%s did not survive the round trip", k)
		}
	}
	if len(got) != 3 {
		t.Errorf("read back %d keys, want 3: %v", len(got), got)
	}
}
