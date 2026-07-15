package admin

import (
	"encoding/json"
	"net/http"
	"strings"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
)

// AWS credentials for the S3 database-backup feature. Super-Admin only.
// The access key id and secret access key are encrypted at rest (AES-256-CBC);
// only a masked access key id is returned by GET, and the secret is only ever
// revealed through the dedicated reveal endpoint.

// maskAKID shows just the first 4 and last 4 characters of an access key id.
func maskAKID(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if len(s) <= 8 {
		return strings.Repeat("•", len(s))
	}
	return s[:4] + strings.Repeat("•", len(s)-8) + s[len(s)-4:]
}

// GET/POST /api/admin/aws-credentials
func AWSCredentials(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		row, _ := db.QueryOne("SELECT id, access_key_id, secret_access_key, region, s3_uri, updated_at FROM aws_credentials ORDER BY id DESC LIMIT 1")
		if row == nil {
			ok(w, map[string]any{"success": true, "configured": false}); return
		}
		ak := safeDecryptMain(row["access_key_id"])
		ok(w, map[string]any{
			"success":      true,
			"configured":   ak != "",
			"accessKeyId":  maskAKID(ak),
			"region":       strVal(row["region"]),
			"s3Uri":        strVal(row["s3_uri"]),
			"hasSecret":    safeDecryptMain(row["secret_access_key"]) != "",
			"updatedAt":    strVal(row["updated_at"]),
		})

	case http.MethodPost:
		var body struct {
			AccessKeyId     string `json:"accessKeyId"`
			SecretAccessKey string `json:"secretAccessKey"`
			Region          string `json:"region"`
			S3Uri           string `json:"s3Uri"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		body.AccessKeyId = strings.TrimSpace(body.AccessKeyId)
		body.Region = strings.TrimSpace(body.Region)
		body.S3Uri = strings.TrimSpace(body.S3Uri)
		if body.AccessKeyId == "" || body.Region == "" || body.S3Uri == "" {
			fail(w, 422, "Access Key ID, Region and S3 URI are required"); return
		}
		if !strings.HasPrefix(body.S3Uri, "s3://") {
			fail(w, 422, "S3 URI must start with s3://"); return
		}

		existing, _ := db.QueryOne("SELECT id, secret_access_key FROM aws_credentials ORDER BY id DESC LIMIT 1")

		// A blank secret on update means "keep the existing one" — the GET never
		// returns the real secret, so a blank submit must not wipe it.
		secretEnc := ""
		if strings.TrimSpace(body.SecretAccessKey) != "" {
			secretEnc = ipauth.EncryptMain(strings.TrimSpace(body.SecretAccessKey))
		} else if existing != nil {
			secretEnc, _ = existing["secret_access_key"].(string)
		}
		if secretEnc == "" {
			fail(w, 422, "Secret Access Key is required"); return
		}

		akEnc := ipauth.EncryptMain(body.AccessKeyId)
		if existing != nil {
			if err := db.MustExec("UPDATE aws_credentials SET access_key_id=?, secret_access_key=?, region=?, s3_uri=? WHERE id=?",
				akEnc, secretEnc, body.Region, body.S3Uri, intVal(existing["id"])); err != nil {
				fail(w, 500, "Could not save AWS credentials"); return
			}
		} else {
			if err := db.MustExec("INSERT INTO aws_credentials (access_key_id, secret_access_key, region, s3_uri) VALUES (?, ?, ?, ?)",
				akEnc, secretEnc, body.Region, body.S3Uri); err != nil {
				fail(w, 500, "Could not save AWS credentials"); return
			}
		}
		ok(w, map[string]any{"success": true})

	default:
		fail(w, 405, "Method not allowed")
	}
}

// GET /api/admin/aws-credentials/reveal — decrypted access key + secret (on demand).
func AWSCredentialsReveal(w http.ResponseWriter, r *http.Request) {
	row, _ := db.QueryOne("SELECT id, access_key_id, secret_access_key FROM aws_credentials ORDER BY id DESC LIMIT 1")
	if row == nil {
		fail(w, 404, "No AWS credentials configured"); return
	}
	logReveal(r, "aws", "aws_credentials")
	ok(w, map[string]any{
		"success":         true,
		"accessKeyId":     safeDecryptMain(row["access_key_id"]),
		"secretAccessKey": safeDecryptMain(row["secret_access_key"]),
	})
}
