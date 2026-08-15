package admin

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/ip-house/iphouse-api/db"
)

// GET/POST /api/admin/data-sharing-config — Super Admin only.
//
// The Data Sharing feature reuses the AWS key/secret stored in aws_credentials
// but uploads to its own bucket, which may live in a different region. This
// endpoint stores the file-sharing S3 URI and region (single row, id=1) so an
// admin can set them explicitly instead of relying on region auto-detection.
func DataSharingConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		row, _ := db.QueryOne("SELECT s3_uri, region, updated_at FROM data_sharing_config WHERE id = 1")
		if row == nil {
			ok(w, map[string]any{
				"success":    true,
				"configured": false,
				"s3Uri":      "s3://mediascan-filestore/file_sharing",
				"region":     "",
			})
			return
		}
		ok(w, map[string]any{
			"success":    true,
			"configured": strVal(row["s3_uri"]) != "",
			"s3Uri":      strVal(row["s3_uri"]),
			"region":     strVal(row["region"]),
			"updatedAt":  strVal(row["updated_at"]),
		})

	case http.MethodPost:
		var body struct {
			S3Uri  string `json:"s3Uri"`
			Region string `json:"region"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		body.S3Uri = strings.TrimSpace(body.S3Uri)
		body.Region = strings.TrimSpace(body.Region)
		if body.S3Uri == "" {
			fail(w, 422, "S3 URI is required")
			return
		}
		if !strings.HasPrefix(body.S3Uri, "s3://") {
			fail(w, 422, "S3 URI must start with s3://")
			return
		}
		if err := db.MustExec(`INSERT INTO data_sharing_config (id, s3_uri, region, updated_at)
			VALUES (1, ?, ?, UTC_TIMESTAMP())
			ON DUPLICATE KEY UPDATE s3_uri = ?, region = ?, updated_at = UTC_TIMESTAMP()`,
			body.S3Uri, body.Region, body.S3Uri, body.Region); err != nil {
			fail(w, 500, "Could not save file-sharing settings")
			return
		}
		ok(w, map[string]any{"success": true})

	default:
		fail(w, 405, "Method not allowed")
	}
}
