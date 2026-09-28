package handlers

import (
	"errors"
	"strings"
	"testing"
)

func TestReportsAPIErrorHidesInternals(t *testing.T) {
	raw := errors.New(`reports API unreachable: Get "http://reports_api:8090/v1/torrent/report/run?clientId=X": dial tcp 172.19.0.2:8090: connect: connection refused`)
	got := reportsAPIError(raw)
	if strings.Contains(got, "172.19") || strings.Contains(got, "reports_api:8090") {
		t.Errorf("internal address leaked: %s", got)
	}
	if !strings.Contains(got, "unreachable") {
		t.Error("the page retries on the word unreachable — it must stay")
	}
	if own := reportsAPIError(errors.New("reports API: One month per search")); own != "reports API: One month per search" {
		t.Errorf("the service's own message must pass through: %s", own)
	}
}
